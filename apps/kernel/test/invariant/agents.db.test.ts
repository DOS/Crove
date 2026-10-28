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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { agentCommands, createOrg, decideApproval, eligibleApprovers, kernelCommands, kernelManifest, kernelQueries, runAgentWake, upsertIdentity } from '@crove/kernel';
import { tableWrite } from '@crove/kernel-contract';
import { Runtime, defineCommand, type Actor, type AgentActor, type AgentApprovers, type AgentRuntime, type CommandDef, type CommandWrite, type Risk } from '@crove/kernel-runtime';
import { financeCommands, financeManifest, financeQueries } from '@crove/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const TEMPLATE = 'finance.chief_accountant';
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };

const suite = ADMIN ? describe : describe.skip;

// Commands an agent may run at all; every other command declares no agent access.
const AGENT_COMMANDS = ['kernel.task.checkout', 'kernel.task.comment', 'kernel.task.set_status', 'kernel.task.escalate', 'kernel.task.delegate'];
// Agent proposals and approvals (#260, ADR-0029 section 6): two more task commands. Accepted here before the feature
// lands, so this invariant holds on both sides of it: proposing is R1 and carries the run's taint into the proposal
// (taint 'propagate'); recording an approval is R1 without it, so the runtime refuses a tainted run (P03). Neither
// writes a proposal: a system command in the worker acts on what they record, after checking it again.
const AGENT_PROPOSAL_COMMANDS: Record<string, 'propagate' | undefined> = {
  'kernel.task.propose': 'propagate',
  'kernel.task.approve_proposal': undefined,
};

// Probe commands for the runtime's agent policy, each declaring agent access for any role. Every probe an agent may run
// declares its writes (#1710): none of them writes a table, only the rows the runtime writes for it.
const probe = (name: string, risk: Risk, taint?: 'propagate'): CommandDef<unknown, unknown> =>
  defineCommand({
    name,
    input: z.object({}),
    risk,
    access: [],
    agent: { roles: 'any', ...(taint ? { taint } : {}) },
    writes: [],
    handler: async () => ({ ok: true }),
  }) as CommandDef<unknown, unknown>;
// t18.whoami: who the runtime runs a command as, and an activity row written in that context.
const whoami = defineCommand({
  name: 't18.whoami',
  input: z.object({ recordId: z.string() }),
  risk: 'R0',
  access: [],
  agent: { roles: 'any' },
  writes: [],
  handler: async (ctx, input) => {
    await ctx.activity('t18.probe', input.recordId, 't18.whoami', 'probe');
    return { actor: ctx.actor, orgId: ctx.orgId, positionId: ctx.agent?.positionId ?? null };
  },
}) as CommandDef<unknown, unknown>;
// #333 item 4: a command that puts another run in its audit detail; the row keeps the actor's run.
const forgeRun333 = defineCommand({
  name: 't333.forge_run',
  input: z.object({}),
  risk: 'R0',
  access: [],
  agent: { roles: 'any' },
  writes: [],
  handler: async (ctx) => {
    ctx.audit({ agentRun: '00000000-0000-4000-8000-000000000000', note: 1 });
    return { ok: true };
  },
}) as CommandDef<unknown, unknown>;
// #260: a preparer agents may run (it writes nothing) and proposal commands of each risk, two of which agents with the
// chief accountant role key may approve.
const prepare260 = defineCommand({
  name: 't260.prepare',
  input: z.object({ command: z.string() }),
  risk: 'R0',
  access: ['owner', 'admin', 'member'],
  agent: { roles: 'any' },
  writes: [],
  handler: async (_ctx, input) => ({ kind: 't260', command: input.command, title: `T260 ${input.command}`, payload: { n: 1 } }),
}) as CommandDef<unknown, unknown>;
const proposal260 = (name: string, risk: Risk, roles?: string[]) =>
  defineCommand({
    name,
    input: z.object({ payload: z.unknown(), acceptFailedChecks: z.boolean().optional() }),
    risk,
    access: 'proposal',
    ...(roles ? { agentApprovers: { roles }, writes: [] } : {}),
    handler: async () => ({ executed: name }),
  }) as CommandDef<unknown, unknown>;
// The same preparer without agent access: humans only.
const prepareHumans260 = defineCommand({
  name: 't260.prepare_humans',
  input: z.object({ command: z.string() }),
  risk: 'R0',
  access: ['owner', 'admin', 'member'],
  handler: async (_ctx, input) => ({ kind: 't260', command: input.command, title: `T260 ${input.command}`, payload: { n: 1 } }),
}) as CommandDef<unknown, unknown>;
// A preparer agents may run that is not read-only (R1): never a preparer of an agent's proposal.
const prepareR1260 = defineCommand({
  name: 't260.prepare_r1',
  input: z.object({ command: z.string() }),
  risk: 'R1',
  access: ['owner', 'admin', 'member'],
  agent: { roles: 'any', taint: 'propagate' },
  writes: [],
  handler: async (_ctx, input) => ({ kind: 't260', command: input.command, title: `T260 ${input.command}`, payload: { n: 1 } }),
}) as CommandDef<unknown, unknown>;
// #435: a preparer that echoes what the agent gives it (kind, title, payload): none of that may become the proposal's
// label, and a payload above the cap is refused. And a proposal command that declares its proposal kind.
const prepareEcho435 = defineCommand({
  name: 't435.prepare_echo',
  input: z.object({ command: z.string(), kind: z.string(), title: z.string(), payload: z.record(z.string(), z.unknown()) }),
  risk: 'R0',
  access: ['owner', 'admin', 'member'],
  agent: { roles: 'any' },
  writes: [],
  handler: async (_ctx, input) => ({ kind: input.kind, command: input.command, title: input.title, payload: input.payload }),
}) as CommandDef<unknown, unknown>;
const proposalKind435 = defineCommand({
  name: 't435.prop_kind',
  input: z.object({ payload: z.unknown(), acceptFailedChecks: z.boolean().optional() }),
  risk: 'R1',
  access: 'proposal',
  proposalKind: 't435.declared',
  handler: async () => ({ executed: 't435.prop_kind' }),
}) as CommandDef<unknown, unknown>;
const PROBES = [
  prepareEcho435,
  proposalKind435,
  prepare260,
  prepareHumans260,
  prepareR1260,
  proposal260('t260.prop_r1', 'R1', [TEMPLATE]),
  proposal260('t260.prop_r2', 'R2', [TEMPLATE]),
  proposal260('t260.prop_r3', 'R3'),
  proposal260('t260.prop_humans', 'R1'),
  probe('t18.r1', 'R1'),
  probe('t18.r1_propagate', 'R1', 'propagate'),
  probe('t18.r2', 'R2', 'propagate'),
  probe('t18.r3', 'R3', 'propagate'),
  probe('t18.r0', 'R0'),
  whoami,
  forgeRun333,
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
// Issue #285: the only tables an agent context writes without agent_write_guard. Each has agent rules of its own
// (task, task_comment, ai_run, activity) or is written only by a definer that stamps or counts from the context
// (outbox_event, refusal_tally). Every other table of every crove_* schema carries the guard.
const AGENT_WRITE_EXEMPT = [
  'crove_kernel.activity',
  'crove_kernel.ai_run',
  'crove_kernel.outbox_event',
  'crove_kernel.refusal_tally',
  'crove_kernel.task',
  'crove_kernel.task_comment',
];
// Guarded tables that accept narrow agent writes (tested on their own below).
const AGENT_WRITE_NARROW = ['crove_kernel.agent_wakeup', 'crove_kernel.audit_event', 'crove_kernel.idempotency_key', 'crove_kernel.outbox_pending'];

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
    expect(declared.filter((name) => !Object.hasOwn(AGENT_PROPOSAL_COMMANDS, name)).sort()).toEqual([...AGENT_COMMANDS].sort());
    expect(financeCommands.filter((c) => (c as CommandDef<unknown, unknown>).agent)).toEqual([]);
    for (const name of AGENT_COMMANDS) {
      const def = agentCommands.find((c) => c.name === name) as CommandDef<unknown, unknown>;
      expect(def.risk, name).toBe('R1');
    }
    for (const name of declared.filter((n) => Object.hasOwn(AGENT_PROPOSAL_COMMANDS, n))) {
      const def = kernelCommands.find((c) => c.name === name) as CommandDef<unknown, unknown>;
      expect(def.risk, name).toBe('R1');
      expect(def.agent?.taint, name).toBe(AGENT_PROPOSAL_COMMANDS[name]);
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

  // Issue #285: an allowlist, not a denylist. The catalog is the list, so a new table is guarded by default.
  it('guards every crove_* table but the exempt few against agent writes, enumerated from the catalog', async () => {
    const tables = await withAdmin(async (c) =>
      (
        await c.query<{ name: string; guarded: boolean }>(
          `SELECT n.nspname || '.' || c.relname AS name,
                  EXISTS (SELECT 1 FROM pg_trigger t
                          WHERE t.tgrelid = c.oid AND t.tgname = 'agent_write_guard' AND NOT t.tgisinternal AND t.tgenabled = 'O'
                            AND t.tgfoid = 'crove_kernel.agent_write_guard()'::regprocedure
                            AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 28) = 28) AS guarded
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname LIKE 'crove\\_%' AND n.nspname <> 'crove_meta'
             AND c.relkind IN ('r', 'p') AND NOT c.relispartition
           ORDER BY 1`,
        )
      ).rows,
    );
    expect(tables.length).toBeGreaterThan(AGENT_WRITE_EXEMPT.length + 20);
    expect(tables.filter((t) => !t.guarded).map((t) => t.name)).toEqual(AGENT_WRITE_EXEMPT);
    // The guard reads the sealed context as its owner, whoever writes, and no role may call it.
    const fn = await withAdmin(async (c) =>
      (
        await c.query<{ definer: boolean; config: string[]; callers: string[] }>(
          `SELECT p.prosecdef AS definer, p.proconfig AS config,
                  ARRAY(SELECT r FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r
                        WHERE has_function_privilege(r, p.oid, 'EXECUTE')) AS callers
           FROM pg_proc p WHERE p.oid = 'crove_kernel.agent_write_guard()'::regprocedure`,
        )
      ).rows[0],
    );
    expect(fn).toEqual({ definer: true, config: ['search_path=pg_catalog, pg_temp'], callers: [] });

    // Every guarded table refuses a row written in an agent context, even by a role that holds every privilege (the
    // guard fires before constraints, so an empty row reaches it).
    const { actor } = await liveAgent(orgA, owner);
    const refusals = await withAdmin(async (c) => {
      const found: Array<[string, string]> = [];
      await c.query('BEGIN');
      try {
        await c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgA, actor.agentId, actor.runId]);
        for (const { name } of tables.filter((t) => t.guarded && !AGENT_WRITE_NARROW.includes(t.name))) {
          await c.query('SAVEPOINT probe');
          const [schema, table] = name.split('.') as [string, string];
          const outcome = await c.query(`INSERT INTO ${schema}."${table}" DEFAULT VALUES`).then(
            () => 'inserted',
            (e: { message: string }) => e.message,
          );
          await c.query('ROLLBACK TO SAVEPOINT probe');
          found.push([name, outcome]);
        }
      } finally {
        await c.query('ROLLBACK');
      }
      return found;
    });
    expect(refusals.filter(([, outcome]) => outcome !== 'AGENT_FORBIDDEN')).toEqual([]);
  });

  it('refuses an agent the tenant tables the denylist left open, through its real login role', async () => {
    const { actor } = await liveAgent(orgA, owner);
    const statements: Array<[string, unknown[]]> = [
      [`INSERT INTO crove_kernel.party (org_id, name) VALUES ($1, 'AI')`, [orgA]],
      [`UPDATE crove_kernel.party SET name = 'AI' WHERE org_id = $1`, [orgA]],
      [`INSERT INTO crove_kernel.file (org_id) VALUES ($1)`, [orgA]],
      [`INSERT INTO crove_kernel.extraction (org_id) VALUES ($1)`, [orgA]],
      [`INSERT INTO crove_finance.purchase_document (org_id) VALUES ($1)`, [orgA]],
    ];
    await withAdmin((c) => c.query(`INSERT INTO crove_kernel.party (org_id, name) VALUES ($1, 'Nhà cung cấp')`, [orgA]));
    for (const [text, values] of statements) {
      await expect(inAgentContext(orgA, actor, (c) => c.query(text, values)), text).rejects.toMatchObject({ code: '42501', message: 'AGENT_FORBIDDEN' });
    }
  });

  // Issue #886: the operator's AI switch stops every agent of every org, in the database as at the gates.
  it('refuses every agent context while the deployment-wide AI switch is engaged, and lets it in once released', async () => {
    const { actor } = await liveAgent(orgA, owner);
    const set = (engaged: boolean) => withAdmin((c) => c.query(`SELECT crove_kernel.global_kill_switch_set('ai', $1, 'diễn tập', 'ops')`, [engaged]));
    await set(true);
    try {
      await expect(inAgentContext(orgA, actor, async () => 'in')).rejects.toMatchObject({ code: '42501', message: 'KILL_SWITCH_ON' });
    } finally {
      await set(false);
    }
    await expect(inAgentContext(orgA, actor, async () => 'in')).resolves.toBe('in');
  });

  // Issue #333 item 4: the actor's run always wins over a run a command puts in its own audit detail.
  it('keeps the agent run of the actor on an audit row, whatever run the command names in its detail', async () => {
    const { actor } = await liveAgent(orgA, owner);
    await worker.execute('t333.forge_run', {}, { actor, orgId: orgA });
    const rows = await withAdmin(async (c) =>
      (await c.query(`SELECT actor_type, actor_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 't333.forge_run' AND actor_id = $2`, [orgA, actor.agentId])).rows,
    );
    expect(rows).toEqual([{ actor_type: 'agent', actor_id: actor.agentId, detail: expect.objectContaining({ agentRun: actor.runId, note: 1 }) }]);
  });

  // Issue #333: pg-boss's tables carry the guard too, and a queue created after the migration inherits it.
  it('refuses an agent every write to the job queue, through its real login role, in queues old and new', async () => {
    const { actor } = await liveAgent(orgA, owner);
    const queue = `test-agent-guard-${randomUUID().slice(0, 8)}`;
    const seeded = await withAdmin(async (c) => {
      await c.query(`SELECT crove_jobs.create_queue($1, '{"policy":"standard","partition":true}'::jsonb)`, [queue]);
      // Outside an agent context the worker's own traffic passes, in the new partition too: one row in each queue, so
      // the updates and deletes below have a row to refuse.
      const ids: string[] = [];
      for (const name of ['kernel-agent-wake', queue]) {
        ids.push((await c.query<{ id: string }>(`INSERT INTO crove_jobs.job (name, data) VALUES ($1, '{}') RETURNING id`, [name])).rows[0]?.id as string);
      }
      return ids;
    });
    const forbidden = { code: '42501', message: 'AGENT_FORBIDDEN' };
    for (const name of ['kernel-agent-wake', queue]) {
      const statements = [
        `INSERT INTO crove_jobs.job (name, data) VALUES ('${name}', '{}')`,
        `UPDATE crove_jobs.job SET state = 'completed' WHERE name = '${name}' AND id = ANY('{${seeded.join(',')}}'::uuid[])`,
        `DELETE FROM crove_jobs.job WHERE name = '${name}' AND id = ANY('{${seeded.join(',')}}'::uuid[])`,
      ];
      for (const text of statements) {
        await expect(inAgentContext(orgA, actor, (c) => c.query(text)), text).rejects.toMatchObject(forbidden);
      }
    }
    await expect(inAgentContext(orgA, actor, (c) => c.query(`SELECT crove_jobs.create_queue('agent-made-queue', '{"policy":"standard"}'::jsonb)`))).rejects.toMatchObject({ code: '42501' });
    // The rows written outside the context are still there and unchanged: the refusals changed nothing.
    const left = await withAdmin(async (c) => (await c.query(`SELECT count(*)::int AS n FROM crove_jobs.job WHERE id = ANY($1::uuid[]) AND state = 'created'`, [seeded])).rows[0]?.n);
    expect(left).toBe(2);
    await withAdmin((c) => c.query(`DELETE FROM crove_jobs.job WHERE id = ANY($1::uuid[])`, [seeded]));
  });

  it('lets an agent write audit rows, idempotency keys and wake-ups only for itself and only forward', async () => {
    const { actor, agentId, positionId } = await liveAgent(orgA, owner);
    // An agent below it in the chart: the only kind of agent its delegations wake.
    const other = await liveAgent(orgA, owner, positionId);
    const outside = await liveAgent(orgA, owner);
    const forbidden = { code: '42501', message: 'AGENT_FORBIDDEN' };
    const audit = (actorType: string, actorId: string, run: string, at = 'now()') => (c: pg.Client) =>
      c.query<{ recent: boolean }>(
        `INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, input_sha256, detail, occurred_at)
         VALUES ($1, $2, $3, 'kernel.org.export.record', $4, 'ok', 'x', $5, ${at})
         RETURNING occurred_at BETWEEN now() - interval '1 minute' AND now() + interval '1 minute' AS recent`,
        [orgA, actorType, actorId, randomUUID(), JSON.stringify({ agentRun: run })],
      );
    await expect(inAgentContext(orgA, actor, audit('user', owner, actor.runId))).rejects.toMatchObject(forbidden);
    await expect(inAgentContext(orgA, actor, audit('agent', other.agentId, actor.runId))).rejects.toMatchObject(forbidden);
    await expect(inAgentContext(orgA, actor, audit('agent', agentId, other.runId))).rejects.toMatchObject(forbidden);
    // Its own row is accepted, dated now whatever it says.
    const own = await inAgentContext(orgA, actor, async (c) => (await audit('agent', agentId, actor.runId, `now() + interval '1 year'`)(c)).rows[0]);
    expect(own).toEqual({ recent: true });
    // An agent row never stands for a command only users or the system run (the offboarding readers skip it).
    await withAdmin((c) => audit('agent', agentId, actor.runId, `now() + interval '1 year'`)(c));
    await expect(app.query('kernel.org.export.get', {}, { actor: asUser(owner), orgId: orgA })).resolves.toMatchObject({ export: null });

    // Pending outbox rows: inserts only, so an agent transaction never claims every org's pending events.
    await expect(inAgentContext(orgA, actor, (c) => c.query('SELECT * FROM crove_kernel.outbox_claim(10)'))).rejects.toMatchObject(forbidden);

    // Idempotency keys: this run's only, so an agent never plants an answer a user's retry would replay.
    const key = (actorKey: string) => (c: pg.Client) =>
      c.query(`INSERT INTO crove_kernel.idempotency_key (org_id, actor_key, key, command, request_sha256) VALUES ($1, $2, 'k', 't18', 'x')`, [orgA, actorKey]);
    await expect(inAgentContext(orgA, actor, key(`user:${owner}`))).rejects.toMatchObject(forbidden);
    await expect(inAgentContext(orgA, actor, key(`agent:${agentId}:${other.runId}`))).rejects.toMatchObject(forbidden);
    await expect(inAgentContext(orgA, actor, key(`agent:${agentId}:${actor.runId}`))).resolves.toMatchObject({ rowCount: 1 });
    await withAdmin((c) =>
      c.query(`INSERT INTO crove_kernel.idempotency_key (org_id, actor_key, key, command, request_sha256) VALUES ($1, $2, 'u', 't18', 'x')`, [orgA, `user:${owner}`]),
    );
    await expect(
      inAgentContext(orgA, actor, (c) => c.query(`UPDATE crove_kernel.idempotency_key SET response = '{"value": 1}' WHERE org_id = $1 AND actor_key = $2`, [orgA, `user:${owner}`])),
    ).rejects.toMatchObject(forbidden);
    await expect(
      inAgentContext(orgA, actor, (c) => c.query(`DELETE FROM crove_kernel.idempotency_key WHERE org_id = $1 AND actor_key = $2`, [orgA, `user:${owner}`])),
    ).rejects.toMatchObject(forbidden);

    // Wake-ups: pending requests only; never claimed or done by an agent, taint never cleared, counts never lowered.
    const wake = await app.execute<{ taskId: string }>('kernel.task.create', { title: 'Đánh thức', assigneePositionId: other.positionId }, { actor: asUser(owner), orgId: orgA });
    expect(wake.taskId).toEqual(expect.any(String));
    // Never for an agent outside its subtree, nor for itself.
    await app.execute('kernel.task.create', { title: 'Ngoài', assigneePositionId: outside.positionId }, { actor: asUser(owner), orgId: orgA });
    await app.execute('kernel.task.create', { title: 'Chính nó', assigneePositionId: positionId }, { actor: asUser(owner), orgId: orgA });
    for (const target of [outside.agentId, agentId]) {
      await expect(
        inAgentContext(orgA, actor, (c) => c.query(`UPDATE crove_kernel.agent_wakeup SET request_count = request_count + 1 WHERE agent_id = $1 AND status = 'pending'`, [target])),
        target,
      ).rejects.toMatchObject(forbidden);
    }
    await withAdmin((c) => c.query(`UPDATE crove_kernel.agent_wakeup SET tainted = true WHERE agent_id = $1 AND status = 'pending'`, [other.agentId]));
    await expect(
      inAgentContext(orgA, actor, (c) => c.query(`UPDATE crove_kernel.agent_wakeup SET status = 'done', run_id = $2 WHERE agent_id = $1 AND status = 'pending'`, [other.agentId, actor.runId])),
    ).rejects.toMatchObject(forbidden);
    await withAdmin((c) => c.query(`UPDATE crove_kernel.agent_wakeup SET request_count = 3, request_depth = 2 WHERE agent_id = $1 AND status = 'pending'`, [other.agentId]));
    await expect(
      inAgentContext(orgA, actor, (c) => c.query(`UPDATE crove_kernel.agent_wakeup SET request_count = 1 WHERE agent_id = $1 AND status = 'pending'`, [other.agentId])),
    ).rejects.toMatchObject(forbidden);
    // The coalescing upsert the runtime makes (count and depth up, reasons appended) is allowed.
    await expect(
      inAgentContext(orgA, actor, (c) =>
        c.query(`UPDATE crove_kernel.agent_wakeup SET request_count = request_count + 1, reasons = reasons || '[{"why": "t18"}]' WHERE agent_id = $1 AND status = 'pending'`, [other.agentId]),
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      inAgentContext(orgA, actor, (c) => c.query(`UPDATE crove_kernel.agent_wakeup SET request_depth = 0 WHERE agent_id = $1 AND status = 'pending'`, [other.agentId])),
    ).rejects.toMatchObject(forbidden);
    const kept = await inAgentContext(orgA, actor, async (c) =>
      (await c.query<{ tainted: boolean }>(`UPDATE crove_kernel.agent_wakeup SET tainted = false WHERE agent_id = $1 AND status = 'pending' RETURNING tainted`, [other.agentId])).rows[0],
    );
    expect(kept).toEqual({ tainted: true });
    await expect(
      inAgentContext(orgA, actor, (c) => c.query(`INSERT INTO crove_kernel.agent_wakeup (org_id, agent_id, status, run_id) VALUES ($1, $2, 'claimed', $3)`, [orgA, other.agentId, actor.runId])),
    ).rejects.toMatchObject(forbidden);
    // A tainted run's new request is tainted whatever it writes.
    await withAdmin((c) => c.query('UPDATE crove_kernel.ai_run SET tainted = true WHERE id = $1', [actor.runId]));
    await withAdmin((c) => c.query(`UPDATE crove_kernel.agent_wakeup SET status = 'done', run_id = $2 WHERE agent_id = $1 AND status = 'pending'`, [other.agentId, other.runId]));
    const inserted = await inAgentContext(orgA, actor, async (c) =>
      (
        await c.query<{ tainted: boolean; request_count: number }>(
          `INSERT INTO crove_kernel.agent_wakeup (org_id, agent_id, tainted, request_count) VALUES ($1, $2, false, 99) RETURNING tainted, request_count`,
          [orgA, other.agentId],
        )
      ).rows[0],
    );
    expect(inserted).toEqual({ tainted: true, request_count: 1 });
  });

  it('never lets an agent delegate to an archived position', async () => {
    const { actor, positionId, taskId } = await liveAgent(orgA, owner);
    const below = await app.execute<{ positionId: string }>('kernel.position.create', { title: 'Đã ngừng', module: 'finance', roleKey: 'finance.accountant', reportsTo: positionId }, { actor: asMfa(owner), orgId: orgA });
    await app.execute('kernel.position.update', { id: below.positionId, status: 'archived' }, { actor: asMfa(owner), orgId: orgA });
    const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: taskId }, { actor, orgId: orgA });
    await expect(
      worker.execute('kernel.task.delegate', { id: taskId, fence, assigneePositionId: below.positionId, title: 'Giao' }, { actor, orgId: orgA }),
    ).rejects.toMatchObject({ code: 'POSITION_ARCHIVED' });
    await expect(
      inAgentContext(orgA, actor, (c) =>
        c.query(
          `INSERT INTO crove_kernel.task (org_id, title, kind, assignee_position_id, parent_task_id, source, created_by_type)
           VALUES ($1, 'x', 'delegation', $2, $3, 'human', 'agent')`,
          [orgA, below.positionId, taskId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501', message: 'AGENT_DELEGATION_SUBTREE' });
  });
  // ---------------------------------------------------------------------------------------------------------------
  // #260: agent proposals and agent approvals (ADR-0029 section 6)
  // ---------------------------------------------------------------------------------------------------------------

  async function newestEvent(orgId: string, type: string): Promise<string> {
    return withAdmin(async (c) =>
      (await c.query<{ id: string }>('SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = $2 ORDER BY id DESC LIMIT 1', [orgId, type])).rows[0]?.id as string,
    );
  }

  async function proposalRow(id: string) {
    return withAdmin(async (c) =>
      (
        await c.query(
          `SELECT command, status, tainted, policy_flags, authors, eligible_approvers, requested_by_agent, requested_by_run, source_task_id,
                  decided_by, decided_by_agent, result FROM crove_kernel.proposal WHERE id = $1`,
          [id],
        )
      ).rows[0],
    );
  }

  // An agent asks for a proposal of `command` from its own task, and the worker creates it.
  async function agentProposes(agent: Awaited<ReturnType<typeof liveAgent>>, command: string, taskId = agent.taskId) {
    const as = { actor: agent.actor, orgId: orgA };
    const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: taskId }, as);
    await worker.execute('kernel.task.propose', { id: taskId, fence, preparer: 't260.prepare', input: { command } }, as);
    const eventId = await newestEvent(orgA, 'kernel.agent.proposal_requested');
    const created = await worker.execute<{ proposalId: string | null; reason: string | null }>('kernel.agent.proposal.create', { eventId }, { actor: SYSTEM, orgId: orgA });
    return { ...created, eventId };
  }

  // The agent named as the requester of assessed proposals written directly (humanProposal): one top-level agent, off
  // the line of every approver the tests start, created once.
  let assessedRequester: Promise<Awaited<ReturnType<typeof liveAgent>>> | null = null;

  // A proposal written directly (admin, no context), and a review task for the approver.
  // flags: the writer's assessment; null means no writer assessed them (every proposal not created from an agent's
  // request). Only an agent's request carries assessed flags (#435), so a proposal written with flags names the chain
  // of a requesting agent that is neither the approver nor on its reporting line.
  async function humanProposal(command: string, extra: { flags?: string[] | null; authors?: unknown[]; tainted?: boolean } = {}) {
    const flags = extra.flags === undefined ? [] : extra.flags;
    const requester = flags === null ? null : await (assessedRequester ??= liveAgent(orgA, owner));
    return withAdmin(async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors, policy_flags, tainted,
                                              requested_by_agent, requested_by_run, source_task_id)
           VALUES ($1, 't260', $2, 'T260', '{}', ARRAY[$3::uuid], $4, $5, $6, $7, $8, $9) RETURNING id`,
          [
            orgA,
            command,
            owner,
            JSON.stringify(extra.authors ?? [{ type: 'user', id: owner }]),
            flags,
            extra.tainted ?? false,
            requester?.agentId ?? null,
            requester?.runId ?? null,
            requester?.taskId ?? null,
          ],
        )
      ).rows[0]?.id as string,
    );
  }

  // A review task as kernel.agent.dispatch_event creates it (system, kind 'proposal_review').
  async function reviewTaskFor(positionId: string, proposalId: string): Promise<string> {
    return withAdmin(async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, kind, assignee_position_id, source, source_ref, created_by_type)
           VALUES ($1, 'Duyệt', 'proposal_review', $2, 'event', $3, 'system') RETURNING id`,
          [orgA, positionId, JSON.stringify({ type: 'kernel.proposal', id: proposalId })],
        )
      ).rows[0]?.id as string,
    );
  }

  // The approver records its approval from a review task (as the agent), and the worker executes it (as the system).
  async function agentApproves(approver: Awaited<ReturnType<typeof liveAgent>>, proposalId: string) {
    const as = { actor: approver.actor, orgId: orgA };
    const taskId = await reviewTaskFor(approver.positionId, proposalId);
    const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: taskId }, as);
    await worker.execute('kernel.task.approve_proposal', { id: taskId, fence, proposalId, revision: 1 }, as);
    const eventId = await newestEvent(orgA, 'kernel.agent.proposal_approved');
    return { eventId, execute: () => worker.execute<{ approved: boolean; reason: string | null }>('kernel.agent.proposal.approve', { eventId }, { actor: SYSTEM, orgId: orgA }) };
  }

  it('declares agent access on exactly the task commands, proposals and approvals included, with their risk and taint', () => {
    const declared = kernelCommands.filter((c) => (c as CommandDef<unknown, unknown>).agent).map((c) => c.name);
    expect(declared.sort()).toEqual([...AGENT_COMMANDS, ...Object.keys(AGENT_PROPOSAL_COMMANDS)].sort());
  });

  it('attributes a proposal to an agent in the Inbox only from the kernel-recorded requester, never from its payload, title or kind (#435)', async () => {
    const agent = await liveAgent(orgA, owner);
    const asked = await agentProposes(agent, 't260.prop_r3');
    const human = await humanProposal('t260.prop_r3', { flags: null });
    const name = await withAdmin(async (c) => (await c.query<{ display_name: string }>('SELECT display_name FROM crove_kernel.agent WHERE id = $1', [agent.agentId])).rows[0]?.display_name as string);
    expect(name).not.toBe('');
    // A human proposal whose payload, title and kind claim an agent origin (and name another agent in the org).
    const spoof = await withAdmin(async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors)
           VALUES ($1, 'finance.purchase', 'finance.purchase.record', $2, $3, ARRAY[$4::uuid], '[]') RETURNING id`,
          [
            orgA,
            `AI agent đề xuất: ${name}`,
            JSON.stringify({ requestedByAgent: { id: agent.agentId, name }, requested_by_agent: agent.agentId, agent: { id: agent.agentId, name } }),
            owner,
          ],
        )
      ).rows[0]?.id as string,
    );
    const as = { actor: asUser(owner), orgId: orgA };
    const items = await app.query<Array<{ id: string; requestedByAgent: { id: string; name: string } | null; extracted: boolean }>>('kernel.inbox.list', {}, as);
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(asked.proposalId as string)).toMatchObject({ requestedByAgent: { id: agent.agentId, name }, extracted: false });
    expect(byId.get(human)?.requestedByAgent).toBeNull();
    expect(byId.get(spoof)?.requestedByAgent).toBeNull();
    const get = (id: string) => app.query<{ requestedByAgent: unknown }>('kernel.inbox.get', { id }, as);
    expect((await get(asked.proposalId as string)).requestedByAgent).toEqual({ id: agent.agentId, name });
    expect((await get(human)).requestedByAgent).toBeNull();
    expect((await get(spoof)).requestedByAgent).toBeNull();
  });

  it('turns R2 and R3 work into a proposal for review, created by the worker with its causal chain, taint and flags', async () => {
    const agent = await liveAgent(orgA, owner);
    // Direct R2 or R3 work stays refused (P05, P06); the agent asks instead.
    const r3 = await agentProposes(agent, 't260.prop_r3');
    expect(r3.reason).toBeNull();
    const row = await proposalRow(r3.proposalId as string);
    expect(row).toMatchObject({
      command: 't260.prop_r3',
      status: 'pending',
      tainted: false,
      // P04: the command declares no agent approvers, so nothing says it writes no contact or payment field.
      policy_flags: ['P04', 'P05'],
      requested_by_agent: agent.agentId,
      requested_by_run: agent.runId,
      source_task_id: agent.taskId,
      decided_by: null,
      decided_by_agent: null,
    });
    // Authors: the agent and its run, and the human who created the task (P10, the creator chain); approvers: humans.
    expect(row.authors).toEqual([{ type: 'agent', id: agent.agentId, run: agent.runId }, { type: 'user', id: owner }]);
    const task = await withAdmin(async (c) => (await c.query('SELECT status, checkout_run_id FROM crove_kernel.task WHERE id = $1', [agent.taskId])).rows[0]);
    expect(task).toEqual({ status: 'waiting', checkout_run_id: null });
    // One proposal per request, however often the job runs.
    await expect(worker.execute('kernel.agent.proposal.create', { eventId: r3.eventId }, { actor: SYSTEM, orgId: orgA })).resolves.toMatchObject({ proposalId: null, reason: 'duplicate' });

    // R2 is flagged P06; a tainted run's request P03; a chain not started by a human P07.
    const second = await liveAgent(orgA, owner);
    const r2 = await agentProposes(second, 't260.prop_r2');
    expect((await proposalRow(r2.proposalId as string)).policy_flags).toEqual(['P06']);
    const third = await liveAgent(orgA, owner);
    await withAdmin((c) => c.query('UPDATE crove_kernel.ai_run SET tainted = true WHERE id = $1', [third.runId]));
    const tainted = await agentProposes(third, 't260.prop_r1');
    expect(await proposalRow(tainted.proposalId as string)).toMatchObject({ tainted: true, policy_flags: ['P03'] });
    const fourth = await liveAgent(orgA, owner);
    const fromEvent = await withAdmin(async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, kind, assignee_position_id, source, created_by_type) VALUES ($1, 'Từ sự kiện', 'general', $2, 'event', 'system') RETURNING id`,
          [orgA, fourth.positionId],
        )
      ).rows[0]?.id as string,
    );
    const untrusted = await agentProposes(fourth, 't260.prop_r1', fromEvent);
    expect((await proposalRow(untrusted.proposalId as string)).policy_flags).toEqual(['P07']);

    // A preparer the agent's role may not run, or one that names no proposal command, makes nothing.
    const fifth = await liveAgent(orgA, owner);
    const as = { actor: fifth.actor, orgId: orgA };
    const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: fifth.taskId }, as);
    await expect(
      worker.execute('kernel.task.propose', { id: fifth.taskId, fence, preparer: 't260.prepare_humans', input: { command: 't260.prop_r1' } }, as),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rule: 'agent_access' } });
    await expect(worker.execute('kernel.task.propose', { id: fifth.taskId, fence, preparer: 't260.prepare', input: { command: 'kernel.task.comment' } }, as)).rejects.toMatchObject({
      code: 'NOT_PROPOSABLE',
    });
    // A preparer above R0 is refused, even one the agent may run: it would write as the agent.
    await expect(worker.execute('kernel.task.propose', { id: fifth.taskId, fence, preparer: 't260.prepare_r1', input: { command: 't260.prop_r1' } }, as)).rejects.toMatchObject({
      code: 'NOT_PROPOSABLE',
    });
    // A forged request (another agent's run on this task) creates nothing.
    const forged = await withAdmin(async (c) =>
      (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.outbox_event (org_id, type, payload) VALUES ($1, 'kernel.agent.proposal_requested', $2) RETURNING id`, [
          orgA,
          JSON.stringify({
            agentId: fifth.agentId,
            runId: second.runId,
            taskId: fifth.taskId,
            preparer: 't260.prepare',
            draft: { kind: 't260', command: 't260.prop_r1', title: 'T260', payload: { n: 1 } },
          }),
        ])
      ).rows[0]?.id as string,
    );
    await expect(worker.execute('kernel.agent.proposal.create', { eventId: forged }, { actor: SYSTEM, orgId: orgA })).resolves.toMatchObject({
      proposalId: null,
      reason: 'chain_mismatch',
    });
  });

  it('flags P04 on an agent proposal of a command that does not declare agent approvers, and drops requests of a dead run', async () => {
    const asker = await liveAgent(orgA, owner);
    const humansOnly = await agentProposes(asker, 't260.prop_humans');
    expect((await proposalRow(humansOnly.proposalId as string)).policy_flags).toEqual(['P04']);
    // A run cancelled (kill switch, stop) before the worker acts on its request creates nothing.
    const cancelled = await liveAgent(orgA, owner);
    const as = { actor: cancelled.actor, orgId: orgA };
    const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: cancelled.taskId }, as);
    await worker.execute('kernel.task.propose', { id: cancelled.taskId, fence, preparer: 't260.prepare', input: { command: 't260.prop_r1' } }, as);
    const eventId = await newestEvent(orgA, 'kernel.agent.proposal_requested');
    await withAdmin((c) => c.query(`UPDATE crove_kernel.ai_run SET status = 'cancelled', finished_at = now() WHERE id = $1`, [cancelled.runId]));
    await expect(worker.execute('kernel.agent.proposal.create', { eventId }, { actor: SYSTEM, orgId: orgA })).resolves.toEqual({ proposalId: null, reason: 'run_not_live' });
  });

  it('refuses agent approvers that do not declare the command writes no contact or payment field (P04)', () => {
    const def = (agentApprovers: unknown, risk: Risk = 'R1') =>
      ({ name: 't260.reg', input: z.object({}), risk, access: 'proposal', agentApprovers, handler: async () => ({}) }) as unknown as CommandDef<unknown, unknown>;
    expect(() => new Runtime(db).register({ commands: [def({ roles: [TEMPLATE] })] })).toThrow(/noContactOrPayment/);
    expect(() => new Runtime(db).register({ commands: [def({ roles: [], noContactOrPayment: true })] })).toThrow(/noContactOrPayment/);
    expect(() => new Runtime(db).register({ commands: [def({ roles: [TEMPLATE], noContactOrPayment: true }, 'R3')] })).toThrow(/R1 or R2/);
    // The old form alone, with no declared writes, is gone (#1710): the command must declare its writes.
    expect(() => new Runtime(db).register({ commands: [def({ roles: [TEMPLATE], noContactOrPayment: true })] })).toThrow(/declares its writes/);
  });

  // #1697: P04 derived from the manifests' column classes. A proposal command declares the tables and columns it
  // writes; an agent's proposal of one that writes a contact or payment column is flagged P04, one that writes neither
  // is not, and a declaration that does not match the classes is refused when the command registers.
  const CONTACT_1697 = tableWrite(kernelManifest.tables, 'crove_kernel', 'party', ['email']);
  const PAYMENT_1697 = tableWrite(financeManifest.tables, 'crove_finance', 'bank_line', ['bank_account']);
  const INTERNAL_1697 = tableWrite(kernelManifest.tables, 'crove_kernel', 'task_comment', ['body']);
  const proposal1697 = (name: string, writes: readonly CommandWrite[] | undefined, extra: Partial<CommandDef<unknown, unknown>> = {}) =>
    defineCommand({
      name,
      input: z.object({ payload: z.unknown(), acceptFailedChecks: z.boolean().optional() }),
      risk: 'R1',
      access: 'proposal',
      ...(writes ? { writes } : {}),
      handler: async () => ({ executed: name }),
      ...extra,
    }) as CommandDef<unknown, unknown>;

  it('flags P04 on an agent proposal of a command that writes a contact or payment column, and not on one that writes neither (#1697)', async () => {
    const commands = [
      proposal1697('t1697.contact', [CONTACT_1697]),
      proposal1697('t1697.payment', [PAYMENT_1697]),
      proposal1697('t1697.mixed', [INTERNAL_1697, CONTACT_1697]),
      proposal1697('t1697.clean', [INTERNAL_1697]),
      proposal1697('t1697.clean_approvers', [INTERNAL_1697], { agentApprovers: { roles: [TEMPLATE] } }),
      // A clean proposal command that runs one which writes a contact column: refused when it executes.
      proposal1697('t1697.nests', [INTERNAL_1697], {
        agentApprovers: { roles: [TEMPLATE] },
        handler: async (ctx) => ctx.run('t1697.inner', {}),
      }),
      defineCommand({ name: 't1697.inner', input: z.object({}), risk: 'R1', access: 'system', writes: [CONTACT_1697], handler: async () => ({ ok: true }) }) as CommandDef<unknown, unknown>,
      // The same through a clean command in between: the bound holds at every depth.
      proposal1697('t1697.nests_deep', [INTERNAL_1697], {
        agentApprovers: { roles: [TEMPLATE] },
        handler: async (ctx) => ctx.run('t1697.middle', {}),
      }),
      defineCommand({
        name: 't1697.middle',
        input: z.object({}),
        risk: 'R1',
        access: 'system',
        writes: [INTERNAL_1697],
        handler: async (ctx) => ctx.run('t1697.inner', {}),
      }) as CommandDef<unknown, unknown>,
    ];
    worker.register({ commands });
    app.register({ commands });
    expect(worker.commandInfo('t1697.contact')?.contactOrPayment).toBe(true);
    expect(worker.commandInfo('t1697.clean')?.contactOrPayment).toBe(false);
    // Undeclared writes: nothing says the command writes no contact or payment column.
    expect(worker.commandInfo('t260.prop_humans')?.contactOrPayment).toBe(true);

    const flags = async (command: string) => {
      const asked = await agentProposes(await liveAgent(orgA, owner), command);
      expect(asked.reason, command).toBeNull();
      return { id: asked.proposalId as string, flags: (await proposalRow(asked.proposalId as string)).policy_flags as string[] };
    };
    expect((await flags('t1697.contact')).flags).toEqual(['P04']);
    expect((await flags('t1697.payment')).flags).toEqual(['P04']);
    expect((await flags('t1697.mixed')).flags).toEqual(['P04']);
    expect((await flags('t1697.clean')).flags).toEqual([]);

    // A clean proposal with agent approvers is approved by an agent; one that would run a contact write fails instead.
    const clean = await flags('t1697.clean_approvers');
    expect(clean.flags).toEqual([]);
    await expect((await agentApproves(await liveAgent(orgA, owner), clean.id)).execute()).resolves.toEqual({ approved: true, reason: null });
    const nests = await flags('t1697.nests');
    expect(nests.flags).toEqual([]);
    // The runtime's refusal is a bug in the command, so the caller gets INTERNAL (the log names the cause) and nothing
    // commits.
    const approval = await agentApproves(await liveAgent(orgA, owner), nests.id);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(approval.execute()).rejects.toMatchObject({ code: 'INTERNAL' });
      expect(logged.mock.calls.flat().map(String).join('\n')).toMatch(/t1697\.nests: declares no contact or payment write \(P04\), so it cannot run t1697\.inner/);
    } finally {
      logged.mockRestore();
    }
    expect((await proposalRow(nests.id)).status).toBe('pending');
    const deep = await flags('t1697.nests_deep');
    expect(deep.flags).toEqual([]);
    const deepApproval = await agentApproves(await liveAgent(orgA, owner), deep.id);
    const deepLogged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(deepApproval.execute()).rejects.toMatchObject({ code: 'INTERNAL' });
      expect(deepLogged.mock.calls.flat().map(String).join('\n')).toMatch(/t1697\.nests_deep: declares no contact or payment write \(P04\), so it cannot run t1697\.inner/);
    } finally {
      deepLogged.mockRestore();
    }
    expect((await proposalRow(deep.id)).status).toBe('pending');
    expect(await withAdmin(async (c) => (await c.query('SELECT count(*)::int AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2', [orgA, 't1697.inner'])).rows[0]?.n)).toBe(0);
  });

  it('refuses declared writes that do not match the column classes, and contact or payment writes by agents (#1697)', () => {
    const register = (def: Partial<CommandDef<unknown, unknown>>) => () =>
      new Runtime(db).register({ commands: [{ name: 't1697.reg', input: z.object({}), risk: 'R1', access: 'proposal', handler: async () => ({}), ...def } as CommandDef<unknown, unknown>] });
    const party = kernelManifest.tables.crove_kernel.party;
    // A column the table does not have, a table not named <schema>.<table>, a table twice, no column, an unknown class.
    expect(register({ writes: [{ table: 'crove_kernel.party', classes: party, columns: ['iban'] }] })).toThrow(/a column its classes do not have/);
    expect(register({ writes: [{ table: 'party', classes: party, columns: ['email'] }] })).toThrow(/<schema>\.<table>/);
    expect(register({ writes: [CONTACT_1697, CONTACT_1697] })).toThrow(/twice/);
    expect(register({ writes: [{ table: 'crove_kernel.party', classes: party, columns: [] }] })).toThrow(/name no column/);
    expect(register({ writes: [{ table: 'crove_kernel.party', classes: party, columns: ['email', 'email'] }] })).toThrow(/twice/);
    expect(register({ writes: [{ table: 'crove_kernel.party', classes: { ...party, email: 'secret' }, columns: ['email'] }] })).toThrow(/unknown class/);
    expect(register({ writes: [{ table: 'crove_kernel.party', classes: {}, columns: ['email'] }] })).toThrow(/no column classes/);
    // Agents never run a command that writes a contact or payment column, and never approve its proposals (P04).
    for (const write of [CONTACT_1697, PAYMENT_1697]) {
      expect(register({ access: [], agent: { roles: 'any' }, writes: [write] })).toThrow(/no agent may run it/);
      expect(register({ agentApprovers: { roles: [TEMPLATE] }, writes: [INTERNAL_1697, write] })).toThrow(/only humans approve/);
      expect(register({ agentApprovers: { roles: [TEMPLATE], noContactOrPayment: true } as AgentApprovers, writes: [write] })).toThrow(/only humans approve/);
    }
    // Agent approvers need declared writes, and no longer take the old noContactOrPayment beside them (#1710).
    expect(register({ agentApprovers: { roles: [TEMPLATE] } })).toThrow(/declares its writes/);
    for (const old of [true, false]) {
      expect(register({ agentApprovers: { roles: [TEMPLATE], noContactOrPayment: old } as AgentApprovers, writes: [INTERNAL_1697] })).toThrow(/noContactOrPayment/);
    }
    expect(register({ agentApprovers: { roles: [TEMPLATE] }, writes: [INTERNAL_1697] })).not.toThrow();
    // A command an agent may run declares its writes (#1710); an empty list says it writes no table.
    expect(register({ access: [], agent: { roles: 'any' } })).toThrow(/an agent may run it, so it declares its writes/);
    expect(register({ access: [], agent: { roles: 'any' }, writes: [] })).not.toThrow();
    expect(register({ access: [], agent: { roles: 'any' }, writes: [INTERNAL_1697] })).not.toThrow();
    expect(register({ writes: [CONTACT_1697, PAYMENT_1697, INTERNAL_1697] })).not.toThrow();
  });

  it('fails a command that writes a table it does not declare, the rows the runtime and declared nested commands write aside (#1710)', async () => {
    const suffix = randomUUID().slice(0, 8);
    const INBOX = tableWrite(kernelManifest.tables, 'crove_kernel', 'inbox_item', ['org_id', 'kind', 'dedupe_key', 'detail', 'raised_at']);
    // Writes an Inbox item straight from the handler.
    const raise = async (ctx: { trx: Parameters<CommandDef<unknown, unknown>['handler']>[0]['trx']; orgId: string; now: Date }, key: string) => {
      await ctx.trx
        .insertInto('crove_kernel.inbox_item')
        .values({ org_id: ctx.orgId, kind: 'kernel.job.dead_lettered', dedupe_key: `t1710:${key}`, detail: JSON.stringify({ queue: 't1710', jobId: randomUUID(), retries: 0 }), raised_at: ctx.now })
        .execute();
    };
    const probe = (name: string, writes: readonly CommandWrite[], handler: CommandDef<unknown, unknown>['handler']) =>
      defineCommand({ name: `t1710.${name}_${suffix}`, input: z.object({}), risk: 'R1', access: 'system', writes, handler }) as CommandDef<unknown, unknown>;
    const undeclared = probe('undeclared', [INTERNAL_1697], async (ctx) => {
      await raise(ctx, `undeclared-${suffix}`);
      return { ok: true };
    });
    const empty = probe('empty', [], async (ctx) => {
      await raise(ctx, `empty-${suffix}`);
      return { ok: true };
    });
    const declared = probe('declared', [INBOX], async (ctx) => {
      await raise(ctx, `declared-${suffix}`);
      return { ok: true };
    });
    // Writes nothing itself: an event, an activity row and a nested command that declares its own writes.
    const delegates = probe('delegates', [], async (ctx) => {
      await ctx.emit('t1710.delegated', { n: 1 });
      await ctx.activity('t1710.probe', randomUUID(), 't1710.delegates', 'probe');
      await ctx.run('kernel.job.dead_letter', { queue: 't1710', jobId: randomUUID(), retries: 0 });
      return { ok: true };
    });
    // A nested command that declares no writes counts as the caller's.
    const undeclaredNested = defineCommand({ name: `t1710.nested_${suffix}`, input: z.object({}), risk: 'R1', access: 'system', handler: async (ctx) => raise(ctx, `nested-${suffix}`) }) as CommandDef<unknown, unknown>;
    const viaNested = probe('via_nested', [], async (ctx) => ctx.run(undeclaredNested.name, {}));
    // A nested command that declares none and writes nothing: its audit row is the runtime's, not the caller's.
    const readOnlyNested = defineCommand({ name: `t1710.reads_${suffix}`, input: z.object({}), risk: 'R0', access: 'system', handler: async () => ({ read: true }) }) as CommandDef<unknown, unknown>;
    const viaReadOnly = probe('via_read_only', [], async (ctx) => ctx.run(readOnlyNested.name, {}));
    // A write beside an event in Promise.all cannot be told from the event's rows, so the command fails.
    const beside = probe('beside', [], async (ctx) => {
      await Promise.all([ctx.emit('t1710.beside', { n: 1 }), raise(ctx, `beside-${suffix}`)]);
      return { ok: true };
    });
    worker.register({ commands: [undeclared, empty, declared, delegates, undeclaredNested, viaNested, readOnlyNested, viaReadOnly, beside] });
    const as = { actor: SYSTEM, orgId: orgA };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const command of [undeclared, empty, viaNested]) {
        await expect(worker.execute(command.name, {}, as), command.name).rejects.toMatchObject({ code: 'INTERNAL' });
        expect(logged.mock.calls.flat().map(String).join('\n')).toContain(`command ${command.name}: wrote crove_kernel.inbox_item, which it does not declare`);
      }
      await expect(worker.execute(beside.name, {}, as)).rejects.toMatchObject({ code: 'INTERNAL' });
      expect(logged.mock.calls.flat().map(String).join('\n')).toContain(`command ${beside.name}: its writes cannot be checked`);
    } finally {
      logged.mockRestore();
    }
    await expect(worker.execute(declared.name, {}, as)).resolves.toEqual({ ok: true });
    await expect(worker.execute(delegates.name, {}, as)).resolves.toEqual({ ok: true });
    await expect(worker.execute(viaReadOnly.name, {}, as)).resolves.toEqual({ read: true });
    // Nothing the refused commands wrote stayed.
    const kept = await withAdmin(async (c) => (await c.query(`SELECT dedupe_key FROM crove_kernel.inbox_item WHERE org_id = $1 AND dedupe_key LIKE $2 ORDER BY 1`, [orgA, `t1710:%${suffix}`])).rows);
    expect(kept).toEqual([{ dedupe_key: `t1710:declared-${suffix}` }]);
  });

  it('runs a command as it registered: agent access set on its definition afterwards grants an agent nothing (#1766)', async () => {
    const contactWriter = defineCommand({
      name: `t1766.contact_writer_${randomUUID().slice(0, 8)}`,
      input: z.object({}),
      risk: 'R1',
      access: ['owner'],
      writes: [CONTACT_1697],
      handler: async () => ({ ok: true }),
    }) as CommandDef<unknown, unknown> & { agent?: unknown };
    worker.register({ commands: [contactWriter] });
    contactWriter.agent = { roles: 'any' };
    const { actor } = await liveAgent(orgA, owner);
    await expect(worker.execute(contactWriter.name, {}, { actor, orgId: orgA })).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rule: 'agent_access' } });
  });

  it('lets an agent approve a clean R1 proposal within its max_risk, executed by the worker through the proposal gate', async () => {
    const requester = await liveAgent(orgA, owner);
    const asked = await agentProposes(requester, 't260.prop_r1');
    expect((await proposalRow(asked.proposalId as string)).policy_flags).toEqual([]);
    const approver = await liveAgent(orgA, owner);
    const { execute } = await agentApproves(approver, asked.proposalId as string);
    await expect(execute()).resolves.toEqual({ approved: true, reason: null });
    expect(await proposalRow(asked.proposalId as string)).toMatchObject({
      status: 'executed',
      decided_by: null,
      decided_by_agent: approver.agentId,
      result: { executed: 't260.prop_r1' },
    });
    // Replayed, it decides nothing more.
    await expect(execute()).resolves.toEqual({ approved: false, reason: 'not_pending' });
  });

  it('never lets an agent approve R3, a flagged or tainted proposal, above its max_risk, its own work or its causal chain', async () => {
    const approver = await liveAgent(orgA, owner);
    const refused = async (proposalId: string, rule: string) => {
      const as = { actor: approver.actor, orgId: orgA };
      const taskId = await reviewTaskFor(approver.positionId, proposalId);
      const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: taskId }, as);
      await expect(worker.execute('kernel.task.approve_proposal', { id: taskId, fence, proposalId, revision: 1 }, as), `${proposalId} ${rule}`).rejects.toMatchObject({
        code: 'AGENT_NOT_ELIGIBLE',
        details: { rule },
      });
    };
    // R3 always ends at a human (P05, P12).
    await refused(await humanProposal('t260.prop_r3'), 'P05');
    // Any of P03 to P07 in the outcome, or tainted content.
    for (const rule of ['P03', 'P04', 'P05', 'P06', 'P07']) await refused(await humanProposal('t260.prop_r1', { flags: [rule] }), rule);
    await refused(await humanProposal('t260.prop_r1', { tainted: true }), 'P03');
    // Above max_risk: the template caps the chief accountant at R1 (P02).
    await refused(await humanProposal('t260.prop_r2'), 'P02');
    // A command that names no agent approvers, or names another role key.
    await refused(await humanProposal('t260.prop_humans'), 'P12');
    // Flags no writer assessed (NULL): never agent-approvable.
    await refused(await humanProposal('t260.prop_r1', { flags: null }), 'P12');
    // An author.
    await refused(await humanProposal('t260.prop_r1', { authors: [{ type: 'agent', id: approver.agentId, run: approver.runId }] }), 'P10');
    // Its own request, and work from its own subtree (an agent below it asked).
    const own = await agentProposes(await liveAgent(orgA, owner, approver.positionId), 't260.prop_r1');
    await refused(own.proposalId as string, 'reporting_line');
    // Its own proposal: it is an author (and asked for it).
    const mine = await liveAgent(orgA, owner);
    const asked = await agentProposes(mine, 't260.prop_r1');
    const as = { actor: mine.actor, orgId: orgA };
    const selfTask = await reviewTaskFor(mine.positionId, asked.proposalId as string);
    const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: selfTask }, as);
    await expect(worker.execute('kernel.task.approve_proposal', { id: selfTask, fence, proposalId: asked.proposalId, revision: 1 }, as)).rejects.toMatchObject({
      code: 'AGENT_NOT_ELIGIBLE',
      details: { rule: 'P10' },
    });
    // A tainted run cannot even record an approval (P03, the runtime).
    const clean = await humanProposal('t260.prop_r1');
    const tainted = await liveAgent(orgA, owner);
    await withAdmin((c) => c.query('UPDATE crove_kernel.ai_run SET tainted = true WHERE id = $1', [tainted.runId]));
    const taintedTask = await reviewTaskFor(tainted.positionId, clean);
    const claimed = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: taintedTask }, { actor: tainted.actor, orgId: orgA });
    await expect(
      worker.execute('kernel.task.approve_proposal', { id: taintedTask, fence: claimed.fence, proposalId: clean, revision: 1 }, { actor: tainted.actor, orgId: orgA }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rule: 'P03' } });
  });

  it('keeps four-eyes along the reporting line and accepts only the review task the dispatch created', async () => {
    // A report never approves its superior's proposal (the superior could route the review to it).
    const superior = await liveAgent(orgA, owner);
    const asked = await agentProposes(superior, 't260.prop_r1');
    expect((await proposalRow(asked.proposalId as string)).policy_flags).toEqual([]);
    const report = await liveAgent(orgA, owner, superior.positionId);
    const as = { actor: report.actor, orgId: orgA };
    const reviewTask = await reviewTaskFor(report.positionId, asked.proposalId as string);
    const leased = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: reviewTask }, as);
    await expect(worker.execute('kernel.task.approve_proposal', { id: reviewTask, fence: leased.fence, proposalId: asked.proposalId, revision: 1 }, as)).rejects.toMatchObject({
      code: 'AGENT_NOT_ELIGIBLE',
      details: { rule: 'reporting_line' },
    });

    // A delegated copy of a review task (created by an agent, kind 'delegation') records no approval, though it names
    // the proposal and the delegate is off the asker's line.
    const asker = await liveAgent(orgA, owner);
    const clean = await agentProposes(asker, 't260.prop_r1');
    const lead = await liveAgent(orgA, owner);
    const delegate = await liveAgent(orgA, owner, lead.positionId);
    const leadTask = await reviewTaskFor(lead.positionId, clean.proposalId as string);
    const leadLease = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: leadTask }, { actor: lead.actor, orgId: orgA });
    const { taskId: copy } = await worker.execute<{ taskId: string }>(
      'kernel.task.delegate',
      { id: leadTask, fence: leadLease.fence, assigneePositionId: delegate.positionId, title: 'Duyệt giúp' },
      { actor: lead.actor, orgId: orgA },
    );
    const copyLease = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: copy }, { actor: delegate.actor, orgId: orgA });
    await expect(
      worker.execute('kernel.task.approve_proposal', { id: copy, fence: copyLease.fence, proposalId: clean.proposalId, revision: 1 }, { actor: delegate.actor, orgId: orgA }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_NOT_TASK' });
    // A forged approval event naming that copy executes nothing either.
    const forged = await withAdmin(async (c) =>
      (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.outbox_event (org_id, type, payload) VALUES ($1, 'kernel.agent.proposal_approved', $2) RETURNING id`, [
          orgA,
          JSON.stringify({ agentId: delegate.agentId, runId: delegate.runId, taskId: copy, proposalId: clean.proposalId, revision: 1 }),
        ])
      ).rows[0]?.id as string,
    );
    await expect(worker.execute('kernel.agent.proposal.approve', { eventId: forged }, { actor: SYSTEM, orgId: orgA })).resolves.toEqual({
      approved: false,
      reason: 'chain_mismatch',
    });
    expect((await proposalRow(clean.proposalId as string)).status).toBe('pending');
  });

  it('decides an agent approval again when the worker executes it: run taint, kill switch, revision', async () => {
    for (const [change, reason] of [
      ['taint', 'tainted_run'],
      ['kill', 'stopped'],
      ['revision', 'stale_revision'],
      ['cancel', 'run_not_live'],
    ] as const) {
      const proposalId = await humanProposal('t260.prop_r1');
      const approver = await liveAgent(orgA, owner);
      const { execute } = await agentApproves(approver, proposalId);
      if (change === 'taint') await withAdmin((c) => c.query('UPDATE crove_kernel.ai_run SET tainted = true WHERE id = $1', [approver.runId]));
      if (change === 'kill') await withAdmin((c) => c.query(`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, 'agent', $2, $3)`, [orgA, approver.agentId, owner]));
      if (change === 'revision') await withAdmin((c) => c.query('UPDATE crove_kernel.proposal SET revision = 2 WHERE id = $1', [proposalId]));
      // A kill switch engaged and released while the job waits leaves the run cancelled.
      if (change === 'cancel') await withAdmin((c) => c.query(`UPDATE crove_kernel.ai_run SET status = 'cancelled', finished_at = now() WHERE id = $1`, [approver.runId]));
      await expect(execute(), change).resolves.toEqual({ approved: false, reason });
      expect((await proposalRow(proposalId)).status, change).toBe('pending');
    }
    // A forged approval (from a task that is not this agent's review of this proposal) executes nothing.
    const proposalId = await humanProposal('t260.prop_r1');
    const approver = await liveAgent(orgA, owner);
    const forged = await withAdmin(async (c) =>
      (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.outbox_event (org_id, type, payload) VALUES ($1, 'kernel.agent.proposal_approved', $2) RETURNING id`, [
          orgA,
          JSON.stringify({ agentId: approver.agentId, runId: approver.runId, taskId: approver.taskId, proposalId, revision: 1 }),
        ])
      ).rows[0]?.id as string,
    );
    await expect(worker.execute('kernel.agent.proposal.approve', { eventId: forged }, { actor: SYSTEM, orgId: orgA })).resolves.toEqual({
      approved: false,
      reason: 'chain_mismatch',
    });
    expect((await proposalRow(proposalId)).status).toBe('pending');
  });

  it('holds every writer to the proposal provenance and to clean agent decisions in the database', async () => {
    const requester = await liveAgent(orgA, owner);
    const asked = await agentProposes(requester, 't260.prop_r1');
    const flagged = await humanProposal('t260.prop_r1', { flags: ['P03'] });
    const taintedRow = await humanProposal('t260.prop_r1', { tainted: true });
    const unassessed = await humanProposal('t260.prop_r1', { flags: null, tainted: true });
    const statements: Array<[string, unknown[], string]> = [
      // An agent decision on a flagged proposal, or by the agent that asked for it.
      [`UPDATE crove_kernel.proposal SET decided_by_agent = $2, status = 'executed' WHERE id = $1`, [flagged, requester.agentId], '23514'],
      [`UPDATE crove_kernel.proposal SET decided_by_agent = $2, status = 'executed' WHERE id = $1`, [asked.proposalId, requester.agentId], '23514'],
      // Flags are never removed; the causal chain and the taint never change.
      [`UPDATE crove_kernel.proposal SET policy_flags = '{}' WHERE id = $1`, [flagged], '23514'],
      [`UPDATE crove_kernel.proposal SET requested_by_agent = NULL, requested_by_run = NULL, source_task_id = NULL WHERE id = $1`, [asked.proposalId], '23514'],
      [`UPDATE crove_kernel.proposal SET tainted = false WHERE id = $1`, [taintedRow], '23514'],
      // Flags nobody assessed never become an assessment, and an agent never decides such a proposal.
      [`UPDATE crove_kernel.proposal SET policy_flags = '{}' WHERE id = $1`, [unassessed], '23514'],
      [`UPDATE crove_kernel.proposal SET decided_by_agent = $2, status = 'executed' WHERE id = $1`, [unassessed, requester.agentId], '23514'],
      // A half chain.
      [`INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, requested_by_agent) VALUES ($1, 't', 't', 't', '{}', $2)`, [orgA, requester.agentId], '23514'],
    ];
    for (const [text, values, code] of statements) {
      await expect(withAdmin((c) => c.query(text, values)), text).rejects.toMatchObject({ code });
    }
    // A tainted proposal is flagged P03 whoever writes it.
    expect((await proposalRow(taintedRow)).policy_flags).toEqual(['P03']);
    // A proposal written without flags keeps none, tainted or not: an empty list would read as "assessed, clean".
    expect((await proposalRow(unassessed)).policy_flags).toBeNull();
    // An agent context still never writes a proposal.
    await expect(
      inAgentContext(orgA, requester.actor, (c) => c.query(`UPDATE crove_kernel.proposal SET status = 'rejected' WHERE id = $1`, [asked.proposalId])),
    ).rejects.toMatchObject({ code: '42501', message: 'AGENT_FORBIDDEN' });
  });

  it('keeps humans for R3 and four-eyes: agent authors never count, and the requesting agent never reviews its proposal', async () => {
    // P10 counts only humans: an agent author neither blocks nor satisfies four-eyes.
    const decided = await db.transaction().execute(async (trx) => {
      await sql`SELECT crove_kernel.enter_context(${owner}::uuid, ${orgA}::uuid)`.execute(trx);
      const base = { command: 'finance.purchase.record', status: 'pending', eligible_approvers: [owner] };
      const agentAuthor = { type: 'agent', id: randomUUID(), run: randomUUID() };
      return {
        agentOnly: await decideApproval(trx, orgA, asUser(owner), { ...base, authors: [agentAuthor] }, { lock: false }),
        withOwner: await decideApproval(trx, orgA, asUser(owner), { ...base, authors: [agentAuthor, { type: 'user', id: owner }] }, { lock: false }),
      };
    });
    expect(decided.agentOnly).toMatchObject({ reason: 'ok', fourEyes: 'pass', selfApproved: false });
    expect(decided.withOwner).toMatchObject({ reason: 'ok', fourEyes: 'self_approved' });
    // Inbox triage of an agent's proposal skips the agent that asked for it.
    const requester = await liveAgent(orgA, owner);
    const asked = await agentProposes(requester, 't260.prop_r3');
    const created = await newestEvent(orgA, 'kernel.proposal.created');
    await worker.execute('kernel.agent.dispatch_event', { eventId: created }, { actor: SYSTEM, orgId: orgA });
    const reviews = await withAdmin(async (c) =>
      (
        await c.query<{ assignee_position_id: string }>(`SELECT assignee_position_id FROM crove_kernel.task WHERE org_id = $1 AND kind = 'proposal_review' AND source_ref->>'id' = $2`, [
          orgA,
          asked.proposalId,
        ])
      ).rows.map((r) => r.assignee_position_id),
    );
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews).not.toContain(requester.positionId);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // #435: hardening of agent proposals and approvals
  // ---------------------------------------------------------------------------------------------------------------

  async function proposalLabel(id: string) {
    return withAdmin(async (c) => (await c.query<{ kind: string; title: string }>('SELECT kind, title FROM crove_kernel.proposal WHERE id = $1', [id])).rows[0]);
  }

  async function eventPayload(id: string): Promise<Record<string, unknown>> {
    return withAdmin(async (c) => (await c.query<{ payload: Record<string, unknown> }>('SELECT payload FROM crove_kernel.outbox_event WHERE id = $1', [id])).rows[0]?.payload ?? {});
  }

  // Inserts an outbox event as the database owner, outside emit(), optionally with the command_id and created_at of
  // a real event (as a forger who copied them would).
  async function forgeEvent(type: string, payload: unknown, copyFrom?: string): Promise<string> {
    return withAdmin(async (c) => {
      const { rows } = copyFrom
        ? await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.outbox_event (org_id, type, payload, command_id, created_at)
             SELECT org_id, $2, $3, command_id, created_at FROM crove_kernel.outbox_event WHERE org_id = $1 AND id = $4 RETURNING id`,
            [orgA, type, JSON.stringify(payload), copyFrom],
          )
        : await c.query<{ id: string }>('INSERT INTO crove_kernel.outbox_event (org_id, type, payload) VALUES ($1, $2, $3) RETURNING id', [orgA, type, JSON.stringify(payload)]);
      return rows[0]?.id as string;
    });
  }

  const createFrom = (eventId: string) =>
    worker.execute<{ proposalId: string | null; reason: string | null }>('kernel.agent.proposal.create', { eventId }, { actor: SYSTEM, orgId: orgA });
  const approveFrom = (eventId: string) => worker.execute<{ approved: boolean; reason: string | null }>('kernel.agent.proposal.approve', { eventId }, { actor: SYSTEM, orgId: orgA });

  it('takes an agent proposal kind from its command and its title from the kernel, and caps the draft payload (#435 N1)', async () => {
    const echo = (command: string, payload: Record<string, unknown> = { n: 1 }) => ({ command, kind: 'finance.journal_reversal', title: 'Đã kiểm tra, duyệt ngay', payload });
    const propose = async (agent: Awaited<ReturnType<typeof liveAgent>>, input: ReturnType<typeof echo>) => {
      const as = { actor: agent.actor, orgId: orgA };
      const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: agent.taskId }, as);
      return worker.execute('kernel.task.propose', { id: agent.taskId, fence, preparer: 't435.prepare_echo', input }, as);
    };
    // The command's declared kind, or its name; never the kind or title the agent's run supplied.
    await propose(await liveAgent(orgA, owner), echo('t435.prop_kind'));
    const declaredEvent = await newestEvent(orgA, 'kernel.agent.proposal_requested');
    const declared = await createFrom(declaredEvent);
    expect(declared.reason).toBeNull();
    const declaredLabel = await proposalLabel(declared.proposalId as string);
    expect(declaredLabel?.kind).toBe('t435.declared');
    expect(declaredLabel?.title).toContain('t435.declared');
    expect(declaredLabel?.title).not.toContain('Đã kiểm tra');
    // The event carries the command and the payload only.
    expect(Object.keys((await eventPayload(declaredEvent)).draft as Record<string, unknown>).sort()).toEqual(['command', 'payload']);
    await propose(await liveAgent(orgA, owner), echo('t260.prop_r1'));
    const named = await createFrom(await newestEvent(orgA, 'kernel.agent.proposal_requested'));
    const namedLabel = await proposalLabel(named.proposalId as string);
    expect(namedLabel?.kind).toBe('t260.prop_r1');
    expect(namedLabel?.title).not.toContain('Đã kiểm tra');

    // A draft payload above the cap is refused when it is recorded.
    await expect(propose(await liveAgent(orgA, owner), echo('t260.prop_r1', { blob: 'x'.repeat(70_000) }))).rejects.toMatchObject({
      code: 'NOT_PROPOSABLE',
      details: { reason: 'payload_too_large' },
    });

    // A proposal kind is declared only on a proposal command, as <module>.<name> within its own module.
    const def = (extra: Record<string, unknown>) =>
      ({ name: 't435.reg', input: z.object({}), risk: 'R1', access: 'proposal', handler: async () => ({}), ...extra }) as unknown as CommandDef<unknown, unknown>;
    expect(() => new Runtime(db).register({ commands: [def({ proposalKind: 'finance.purchase' })] })).toThrow(/proposal kind/);
    expect(() => new Runtime(db).register({ commands: [def({ proposalKind: 't435.kind', access: ['owner'] })] })).toThrow(/proposal kind/);
    expect(() => new Runtime(db).register({ commands: [def({ proposalKind: 'T435 Kind' })] })).toThrow(/proposal kind/);
    expect(() => new Runtime(db).register({ commands: [def({ proposalKind: 't435.kind' })] })).not.toThrow();
  });

  it('keeps assessed flags to agent requests in the database (#435 N2)', async () => {
    const insert = (flags: string | null) =>
      withAdmin((c) =>
        c.query(
          `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors, policy_flags)
           VALUES ($1, 't', 't260.prop_r1', 't', '{}', ARRAY[$2::uuid], '[]', $3)`,
          [orgA, owner, flags],
        ),
      );
    for (const flags of ['{}', '{P03}']) await expect(insert(flags), flags).rejects.toMatchObject({ code: '23514' });
    // Unassessed (NULL) flags need no requester.
    await expect(insert(null)).resolves.toMatchObject({ rowCount: 1 });
  });

  it('refuses agent proposals and approvals when a kill switch covering the agent was engaged since the request, released or not (#435 N3)', async () => {
    const killSwitch = (scope: 'agent' | 'module', target: string, released: boolean, engagedAt = 'now()') =>
      withAdmin((c) =>
        c.query(
          `INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by, engaged_at, released_by, released_at)
           VALUES ($1, $2, $3, $4, ${engagedAt}, CASE WHEN $5::boolean THEN $4::uuid END, CASE WHEN $5::boolean THEN now() END)`,
          [orgA, scope, target, owner, released],
        ),
      );
    // Approval: a switch engaged and released while the job waited refuses it, at agent or module scope.
    for (const scope of ['agent', 'module'] as const) {
      const proposalId = await humanProposal('t260.prop_r1');
      const approver = await liveAgent(orgA, owner);
      const { execute } = await agentApproves(approver, proposalId);
      await killSwitch(scope, scope === 'agent' ? approver.agentId : 'finance', true);
      await expect(execute(), scope).resolves.toEqual({ approved: false, reason: 'stopped' });
      expect((await proposalRow(proposalId)).status, scope).toBe('pending');
    }
    // A switch engaged and released before the approval was recorded does not.
    const proposalId = await humanProposal('t260.prop_r1');
    const approver = await liveAgent(orgA, owner);
    await killSwitch('agent', approver.agentId, true, `now() - interval '1 minute'`);
    const { execute } = await agentApproves(approver, proposalId);
    await expect(execute()).resolves.toEqual({ approved: true, reason: null });

    // Proposal: an engaged switch covering the agent creates nothing, nor does one engaged and released after the
    // request of a run that had already finished (so no stop cancelled it).
    const record = async (agent: Awaited<ReturnType<typeof liveAgent>>) => {
      const as = { actor: agent.actor, orgId: orgA };
      const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: agent.taskId }, as);
      await worker.execute('kernel.task.propose', { id: agent.taskId, fence, preparer: 't260.prepare', input: { command: 't260.prop_r1' } }, as);
      return newestEvent(orgA, 'kernel.agent.proposal_requested');
    };
    const engaged = await liveAgent(orgA, owner);
    const engagedEvent = await record(engaged);
    await killSwitch('agent', engaged.agentId, false);
    await expect(createFrom(engagedEvent)).resolves.toEqual({ proposalId: null, reason: 'stopped' });
    await withAdmin((c) => c.query('UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = $2 WHERE target = $1 AND released_at IS NULL', [engaged.agentId, owner]));
    const finished = await liveAgent(orgA, owner);
    const finishedEvent = await record(finished);
    await worker.execute('kernel.agent.run.finish', { runId: finished.runId, outcome: 'succeeded' }, { actor: SYSTEM, orgId: orgA });
    await killSwitch('agent', finished.agentId, true);
    await expect(createFrom(finishedEvent)).resolves.toEqual({ proposalId: null, reason: 'stopped' });
  });

  it('refuses an agent approval when no position of the asking agent is known (#435 N4)', async () => {
    const requester = await liveAgent(orgA, owner);
    const orphan = await withAdmin(async (c) => {
      const task = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, kind, source, created_by_type, created_by_id) VALUES ($1, 'Không giao', 'general', 'human', 'user', $2) RETURNING id`,
          [orgA, owner],
        )
      ).rows[0]?.id as string;
      await c.query('UPDATE crove_kernel.position SET holder_agent_id = NULL WHERE id = $1', [requester.positionId]);
      return (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors, policy_flags, requested_by_agent, requested_by_run, source_task_id)
           VALUES ($1, 't260', 't260.prop_r1', 'T435', '{}', ARRAY[$2::uuid], $3, '{}', $4, $5, $6) RETURNING id`,
          [orgA, owner, JSON.stringify([{ type: 'user', id: owner }]), requester.agentId, requester.runId, task],
        )
      ).rows[0]?.id as string;
    });
    const approver = await liveAgent(orgA, owner);
    const as = { actor: approver.actor, orgId: orgA };
    const taskId = await reviewTaskFor(approver.positionId, orphan);
    const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: taskId }, as);
    await expect(worker.execute('kernel.task.approve_proposal', { id: taskId, fence, proposalId: orphan, revision: 1 }, as)).rejects.toMatchObject({
      code: 'AGENT_NOT_ELIGIBLE',
      details: { rule: 'reporting_line' },
    });
  });

  it('acts only on events the agent command emitted, for the agent, run, task and target its audit row names (#435)', async () => {
    // Create: an event another command emitted (the agent's own checkout: same command_id and transaction time) and
    // the agent's real request re-pointed at another agent's run and task, or at another command, create nothing.
    const asker = await liveAgent(orgA, owner);
    const as = { actor: asker.actor, orgId: orgA };
    const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: asker.taskId }, as);
    const request = { agentId: asker.agentId, runId: asker.runId, taskId: asker.taskId, preparer: 't260.prepare', draft: { command: 't260.prop_r1', payload: { n: 1 } } };
    const fromCheckout = await withAdmin(async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.outbox_event (org_id, type, payload, command_id, created_at)
           SELECT org_id, 'kernel.agent.proposal_requested', $2, command_id, occurred_at FROM crove_kernel.audit_event
           WHERE org_id = $1 AND command = 'kernel.task.checkout' AND actor_id = $3 ORDER BY occurred_at DESC LIMIT 1 RETURNING id`,
          [orgA, JSON.stringify(request), asker.agentId],
        )
      ).rows[0]?.id as string,
    );
    expect(fromCheckout).toEqual(expect.any(String));
    await expect(createFrom(fromCheckout)).resolves.toEqual({ proposalId: null, reason: 'chain_mismatch' });
    await worker.execute('kernel.task.propose', { id: asker.taskId, fence, preparer: 't260.prepare', input: { command: 't260.prop_r1' } }, as);
    const real = await newestEvent(orgA, 'kernel.agent.proposal_requested');
    const other = await liveAgent(orgA, owner);
    const repointed = await forgeEvent('kernel.agent.proposal_requested', { ...request, agentId: other.agentId, runId: other.runId, taskId: other.taskId }, real);
    await expect(createFrom(repointed)).resolves.toEqual({ proposalId: null, reason: 'chain_mismatch' });
    const anotherCommand = await forgeEvent('kernel.agent.proposal_requested', { ...request, draft: { command: 't260.prop_humans', payload: { n: 1 } } }, real);
    await expect(createFrom(anotherCommand)).resolves.toEqual({ proposalId: null, reason: 'chain_mismatch' });
    // The real request still creates its proposal.
    await expect(createFrom(real)).resolves.toMatchObject({ reason: null });

    // Approve: an approval event no approval command emitted, naming the agent's own review task of a clean proposal,
    // executes nothing; nor does a real approval re-pointed at another (finished) run of the same agent, or at
    // another revision.
    const proposalId = await humanProposal('t260.prop_r1');
    const approver = await liveAgent(orgA, owner);
    const reviewTask = await reviewTaskFor(approver.positionId, proposalId);
    const unbound = await forgeEvent('kernel.agent.proposal_approved', { agentId: approver.agentId, runId: approver.runId, taskId: reviewTask, proposalId, revision: 1 });
    await expect(approveFrom(unbound)).resolves.toEqual({ approved: false, reason: 'chain_mismatch' });
    expect((await proposalRow(proposalId)).status).toBe('pending');
    const { eventId: approval, execute } = await agentApproves(approver, proposalId);
    const oldRun = await withAdmin(async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.ai_run (org_id, agent_id, module, status, tainted, started_at, expires_at, finished_at)
           VALUES ($1, $2, 'finance', 'succeeded', false, now() - interval '1 hour', now() - interval '45 minutes', now() - interval '50 minutes') RETURNING id`,
          [orgA, approver.agentId],
        )
      ).rows[0]?.id as string,
    );
    const approvalPayload = await eventPayload(approval);
    await expect(approveFrom(await forgeEvent('kernel.agent.proposal_approved', { ...approvalPayload, runId: oldRun }, approval))).resolves.toEqual({
      approved: false,
      reason: 'chain_mismatch',
    });
    await expect(approveFrom(await forgeEvent('kernel.agent.proposal_approved', { ...approvalPayload, revision: 2 }, approval))).resolves.toEqual({
      approved: false,
      reason: 'chain_mismatch',
    });
    expect((await proposalRow(proposalId)).status).toBe('pending');
    // The real approval still executes.
    await expect(execute()).resolves.toEqual({ approved: true, reason: null });
  });
});
