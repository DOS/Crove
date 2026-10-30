// Product flow of ADR-0029 Phase 1 (issue #79): the finance.chief_accountant agent triages new proposals and hands
// the approval to a human. Security rules (T18) live in test/invariant/agents.db.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, runAgentWake, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeAgentPrograms, financeCommands, financeQueries, reviewText } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const suite = ADMIN ? describe : describe.skip;

suite('agent positions, tasks and wake-ups on PostgreSQL (ADR-0029 Phase 1)', () => {
  const dbName = `crove_test_agents_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  // The same database served by a deployment that enables only the kernel (CROVE_MODULES=kernel, ADR-0031).
  let kernelOnly: { app: Runtime; worker: Runtime };
  let owner = '';
  let orgId = '';

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

  // The sweep's answer for one agent, read as the worker login role.
  async function due(agentId: string, modules?: string[]) {
    const url = new URL(adminUrl);
    url.username = 'crove_worker';
    url.password = 'test-worker-pw';
    const w = new pg.Client({ connectionString: url.toString() });
    await w.connect();
    try {
      const { rows } = modules
        ? await w.query<{ org_id: string; agent_id: string }>('SELECT * FROM crove_kernel.agent_wakeups_due(100, $1::text[])', [modules])
        : await w.query<{ org_id: string; agent_id: string }>('SELECT * FROM crove_kernel.agent_wakeups_due(100)');
      return rows.filter((r) => r.agent_id === agentId);
    } finally {
      await w.end();
    }
  }

  // Makes the agent's pending wake-up old enough for the sweep (a minute).
  async function age(agentId: string) {
    await admin((c) => c.query(`UPDATE crove_kernel.agent_wakeup SET updated_at = now() - interval '2 minutes' WHERE agent_id = $1 AND status = 'pending'`, [agentId]));
  }

  // A pending proposal and its kernel.proposal.created event, as the extraction writes them.
  async function proposalCreated(title: string, checks: Array<{ id: string; status: string; message: string }>) {
    return admin(async (c) => {
      const proposal = await c.query<{ id: string }>(
        `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors)
         VALUES ($1, 'finance.purchase', 'finance.purchase.record', $2, $3, ARRAY[$4::uuid], '[]') RETURNING id`,
        [orgId, title, JSON.stringify({ checks }), owner],
      );
      const proposalId = proposal.rows[0]?.id as string;
      const event = await c.query<{ id: string }>(
        `INSERT INTO crove_kernel.outbox_event (org_id, type, payload) VALUES ($1, 'kernel.proposal.created', $2) RETURNING id`,
        [orgId, JSON.stringify({ proposalId, kind: 'finance.purchase' })],
      );
      return { proposalId, eventId: event.rows[0]?.id as string };
    });
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
    const runtimeFor = (user: string, password: string, withFinance = true) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      const pool = createPool({ connectionString: url.toString(), max: 4 });
      pools.push(pool);
      const db = createDb(pool);
      const registry = withFinance
        ? { commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] }
        : { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
      return { db, runtime: new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry) };
    };
    const api = runtimeFor('crove_app', 'test-app-pw');
    app = api.runtime;
    worker = runtimeFor('crove_worker', 'test-worker-pw').runtime;
    kernelOnly = { app: runtimeFor('crove_app', 'test-app-pw', false).runtime, worker: runtimeFor('crove_worker', 'test-worker-pw', false).runtime };
    owner = await upsertIdentity(api.db, { issuer: 'agents', subject: 'owner', email: 'owner@agents.test', name: null });
    orgId = (await createOrg(app, asUser(owner), 'Agents')).orgId;
  });

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('triages a new proposal: a review task, one coalesced wake-up, a run that comments and escalates to the owner', async () => {
    const { agentId, positionId } = await app.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant' },
      { actor: asMfa(owner), orgId },
    );
    const checks = [
      { id: 'tax_code', status: 'pass', message: 'Mã số thuế hợp lệ' },
      { id: 'total', status: 'fail', message: 'Tổng tiền không khớp' },
    ];
    const first = await proposalCreated('Hóa đơn 1', checks);
    const second = await proposalCreated('Hóa đơn 2', []);
    for (const { eventId } of [first, second, first]) {
      await worker.execute('kernel.agent.dispatch_event', { eventId }, { actor: SYSTEM, orgId });
    }
    const state = await admin(async (c) => ({
      tasks: (await c.query('SELECT title, kind, tainted, status FROM crove_kernel.task WHERE org_id = $1 ORDER BY created_at', [orgId])).rows,
      wakeups: (await c.query('SELECT status, request_count FROM crove_kernel.agent_wakeup WHERE org_id = $1', [orgId])).rows,
    }));
    // A redelivered event adds nothing; two tasks share one pending wake-up.
    expect(state.tasks).toEqual([
      { title: 'Rà soát đề xuất chờ duyệt', kind: 'proposal_review', tainted: false, status: 'todo' },
      { title: 'Rà soát đề xuất chờ duyệt', kind: 'proposal_review', tainted: false, status: 'todo' },
    ]);
    expect(state.wakeups).toEqual([{ status: 'pending', request_count: 2 }]);

    const result = await runAgentWake({ runtime: worker, programs: financeAgentPrograms }, orgId, agentId);
    expect(result).toMatchObject({ runId: expect.any(String), outcome: 'succeeded' });
    const after = await admin(async (c) => ({
      reviews: (await c.query(`SELECT status, checkout_run_id FROM crove_kernel.task WHERE org_id = $1 AND kind = 'proposal_review' ORDER BY created_at`, [orgId])).rows,
      escalations: (
        await c.query(`SELECT title, assignee_position_id, request_depth, created_by_type, created_by_id FROM crove_kernel.task WHERE org_id = $1 AND kind = 'escalation' ORDER BY title`, [orgId])
      ).rows,
      comments: (await c.query(`SELECT body, author_type, author_id FROM crove_kernel.task_comment WHERE org_id = $1 ORDER BY created_at`, [orgId])).rows,
      run: (await c.query('SELECT status FROM crove_kernel.ai_run WHERE org_id = $1', [orgId])).rows,
      wakeups: (await c.query('SELECT status FROM crove_kernel.agent_wakeup WHERE org_id = $1', [orgId])).rows,
      audit: (await c.query(`SELECT count(*)::int AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND actor_type = 'agent' AND actor_id = $2`, [orgId, agentId])).rows[0],
    }));
    expect(after.reviews).toEqual([
      { status: 'waiting', checkout_run_id: null },
      { status: 'waiting', checkout_run_id: null },
    ]);
    // No human holds a position up the chart, so the approval goes to the owner (the root: no position).
    expect(after.escalations).toEqual([
      { title: 'Duyệt đề xuất đã rà soát', assignee_position_id: null, request_depth: 1, created_by_type: 'agent', created_by_id: agentId },
      { title: 'Duyệt đề xuất đã rà soát', assignee_position_id: null, request_depth: 1, created_by_type: 'agent', created_by_id: agentId },
    ]);
    expect(after.comments[0]).toEqual({ body: reviewText({ id: first.proposalId, title: 'Hóa đơn 1', status: 'pending', checks }), author_type: 'agent', author_id: agentId });
    expect(after.run).toEqual([{ status: 'succeeded' }]);
    expect(after.wakeups).toEqual([{ status: 'done' }]);
    // checkout, comment and escalate for each task, each on its own agent audit row.
    expect(after.audit.n).toBe(6);
    // The events record who emitted them (#333): the owner installed the agent, the system's dispatch asked for the
    // wake-up, and the agent's run escalated (not a system event any more). The proposal events this test inserts as
    // the database owner, outside emit(), carry no actor.
    const events = await admin(
      async (c) =>
        (
          await c.query<{ type: string; actor_type: string; actor_id: string | null; agent_id: string | null; agent_run: string | null }>(
            `SELECT type, actor_type, actor_id, agent_id, agent_run FROM crove_kernel.outbox_event
             WHERE org_id = $1 AND type IN ('kernel.agent.installed', 'kernel.agent.wakeup_requested', 'kernel.task.escalated', 'kernel.proposal.created')
             ORDER BY created_at, id`,
            [orgId],
          )
        ).rows,
    );
    const runId = (result as { runId: string }).runId;
    expect(events.find((e) => e.type === 'kernel.agent.installed')).toEqual({ type: 'kernel.agent.installed', actor_type: 'user', actor_id: owner, agent_id: null, agent_run: null });
    expect(new Set(events.filter((e) => e.type === 'kernel.agent.wakeup_requested').map((e) => e.actor_type))).toEqual(new Set(['system']));
    expect(events.filter((e) => e.type === 'kernel.proposal.created').map((e) => e.actor_type)).toEqual([null, null]);
    expect(events.filter((e) => e.type === 'kernel.task.escalated')).toEqual([
      { type: 'kernel.task.escalated', actor_type: 'agent', actor_id: null, agent_id: agentId, agent_run: runId },
      { type: 'kernel.task.escalated', actor_type: 'agent', actor_id: null, agent_id: agentId, agent_run: runId },
    ]);

    // The owner sees the escalations as their own tasks, and the chart shows the AI seat.
    const mine = await app.query<{ tasks: Array<{ kind: string }> }>('kernel.task.list', { mine: true }, { actor: asUser(owner), orgId });
    expect(mine.tasks.map((t) => t.kind)).toEqual(['escalation', 'escalation']);
    const chart = await app.query<{ positions: Array<{ id: string; holder: { ai: boolean } | null }> }>('kernel.chart.get', {}, { actor: asUser(owner), orgId });
    expect(chart.positions.find((p) => p.id === positionId)?.holder).toMatchObject({ type: 'agent', agentId, ai: true });

    // Nothing pending: the next wake-up starts no run.
    await expect(runAgentWake({ runtime: worker, programs: financeAgentPrograms }, orgId, agentId)).resolves.toEqual({ runId: null, reason: 'idle' });
  });

  it('keeps a refused wake-up pending and finds it again in the sweep once the agent can run', async () => {
    const { agentId, positionId } = await app.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', displayName: 'Kế toán trưởng 3' },
      { actor: asMfa(owner), orgId },
    );
    await app.execute('kernel.agent.update', { id: agentId, dailyRunCap: 1 }, { actor: asMfa(owner), orgId });
    await app.execute('kernel.task.create', { title: 'Một', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
    await expect(runAgentWake({ runtime: worker, programs: financeAgentPrograms }, orgId, agentId)).resolves.toMatchObject({ outcome: 'succeeded' });
    await app.execute('kernel.task.create', { title: 'Hai', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
    await expect(runAgentWake({ runtime: worker, programs: financeAgentPrograms }, orgId, agentId)).resolves.toEqual({ runId: null, reason: 'daily_cap' });
    expect(await due(agentId)).toEqual([]);
    await age(agentId);
    // Still at its daily cap: the sweep leaves it out (no refused start, no audit row every 10 minutes).
    expect(await due(agentId)).toEqual([]);
    await app.execute('kernel.agent.update', { id: agentId, dailyRunCap: 2 }, { actor: asMfa(owner), orgId });
    await age(agentId);
    expect(await due(agentId)).toEqual([{ org_id: orgId, agent_id: agentId }]);
  });

  it('leaves kill-switched, out-of-budget and disabled-module agents out of the sweep', async () => {
    const { agentId, positionId } = await app.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', displayName: 'Kế toán trưởng 4' },
      { actor: asMfa(owner), orgId },
    );
    await app.execute('kernel.task.create', { title: 'Chờ', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
    await age(agentId);
    expect(await due(agentId)).toEqual([{ org_id: orgId, agent_id: agentId }]);
    // Only the enabled modules' agents, when the worker passes them.
    expect(await due(agentId, ['kernel'])).toEqual([]);
    expect(await due(agentId, ['kernel', 'finance'])).toEqual([{ org_id: orgId, agent_id: agentId }]);

    const { killSwitchId } = await app.execute<{ killSwitchId: string }>('kernel.agent.kill_switch.engage', { scope: 'agent', target: agentId }, { actor: asUser(owner), orgId });
    expect(await due(agentId)).toEqual([]);
    await app.execute('kernel.agent.kill_switch.release', { id: killSwitchId }, { actor: asMfa(owner), orgId });
    await age(agentId);
    expect(await due(agentId)).toEqual([{ org_id: orgId, agent_id: agentId }]);

    // A spent hard-stop budget (a limit of 0 is spent at once) keeps it out too.
    await app.execute('kernel.agent.budget.set', { scope: 'agent', target: agentId, monthlyLimit: '0' }, { actor: asMfa(owner), orgId });
    await age(agentId);
    expect(await due(agentId)).toEqual([]);
    await app.execute('kernel.agent.budget.set', { scope: 'agent', target: agentId, monthlyLimit: '10' }, { actor: asMfa(owner), orgId });
    await age(agentId);
    expect(await due(agentId)).toEqual([{ org_id: orgId, agent_id: agentId }]);
  });

  it('installs no template and wakes no agent of a module the deployment does not enable', async () => {
    const { agentId, positionId } = await app.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', displayName: 'Kế toán trưởng 5' },
      { actor: asMfa(owner), orgId },
    );
    // The same database, served by a deployment with CROVE_MODULES=kernel.
    await expect(
      kernelOnly.app.execute('kernel.agent.template.install', { templateKey: 'finance.chief_accountant' }, { actor: asMfa(owner), orgId }),
    ).rejects.toMatchObject({ code: 'MODULE_DISABLED', status: 409 });
    const wakeEvents = async () =>
      admin(async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.agent.wakeup_requested'`, [orgId])).rows[0]?.n);
    const before = await wakeEvents();
    await kernelOnly.app.execute('kernel.task.create', { title: 'Không đánh thức', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
    // The request stays pending for when the module is enabled again, but nothing wakes the agent now.
    expect(await wakeEvents()).toBe(before);
    const pending = await admin(async (c) => (await c.query(`SELECT status FROM crove_kernel.agent_wakeup WHERE agent_id = $1 AND status = 'pending'`, [agentId])).rows);
    expect(pending).toEqual([{ status: 'pending' }]);
    await expect(kernelOnly.worker.execute('kernel.agent.run.start', { agentId }, { actor: SYSTEM, orgId })).resolves.toEqual({ runId: null, reason: 'module_disabled' });
    // Inbox triage skips it as well.
    const { eventId } = await proposalCreated('Hóa đơn tắt phân hệ', []);
    const tasksBefore = await admin(async (c) => (await c.query(`SELECT count(*)::int AS n FROM crove_kernel.task WHERE assignee_position_id = $1`, [positionId])).rows[0]);
    await kernelOnly.worker.execute('kernel.agent.dispatch_event', { eventId }, { actor: SYSTEM, orgId });
    const tasksAfter = await admin(async (c) => (await c.query(`SELECT count(*)::int AS n FROM crove_kernel.task WHERE assignee_position_id = $1`, [positionId])).rows[0]);
    expect(tasksAfter).toEqual(tasksBefore);
  });

  it('runs one run per agent at a time and pauses an agent at once', async () => {
    const { agentId, positionId } = await app.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', displayName: 'Kế toán trưởng 2' },
      { actor: asMfa(owner), orgId },
    );
    await app.execute('kernel.task.create', { title: 'Một', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
    const run = await worker.execute<{ runId: string }>('kernel.agent.run.start', { agentId }, { actor: SYSTEM, orgId });
    await app.execute('kernel.task.create', { title: 'Hai', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
    await expect(worker.execute('kernel.agent.run.start', { agentId }, { actor: SYSTEM, orgId })).resolves.toEqual({ runId: null, reason: 'busy' });
    await app.execute('kernel.agent.update', { id: agentId, status: 'paused' }, { actor: asMfa(owner), orgId });
    const status = await admin(async (c) => (await c.query('SELECT status FROM crove_kernel.ai_run WHERE id = $1', [run.runId])).rows[0]);
    expect(status).toEqual({ status: 'cancelled' });
    await expect(worker.execute('kernel.agent.run.start', { agentId }, { actor: SYSTEM, orgId })).resolves.toEqual({ runId: null, reason: 'not_runnable' });
  });
  // The chart answers each position's legal entities (#1763), for the agents screen's picker: ['*'], or the ids the
  // reader may see, so a member limited to some entities learns no other entity's id. The owner sets them on create and
  // changes them on update.
  it("answers each position's legal entities, only those the reader sees", async () => {
    const [defaultEntity, branch] = await admin(async (c) => [
      (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string,
      (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh 1763', 'branch', $2) RETURNING id`, [orgId, owner]))
        .rows[0]?.id as string,
    ]);
    const limited = await upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'agents', subject: 'limited-1763', email: 'limited@agents.test', name: null });
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, limited]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        limited,
        defaultEntity,
        owner,
      ]);
    });
    const { positionId } = await app.execute<{ positionId: string }>(
      'kernel.position.create',
      { title: 'Kế toán hai pháp nhân', module: 'finance', roleKey: 'finance.accountant', leScope: [defaultEntity, branch] },
      { actor: asMfa(owner), orgId },
    );
    const scopeOf = async (userId: string) => {
      const chart = await app.query<{ positions: Array<{ id: string; leScope: string[] }> }>('kernel.chart.get', {}, { actor: asUser(userId), orgId });
      return chart.positions.find((p) => p.id === positionId)?.leScope;
    };
    expect(new Set(await scopeOf(owner))).toEqual(new Set([defaultEntity, branch]));
    expect(await scopeOf(limited)).toEqual([defaultEntity]);
    await app.execute('kernel.position.update', { id: positionId, leScope: ['*'] }, { actor: asMfa(owner), orgId });
    expect(await scopeOf(owner)).toEqual(['*']);
    expect(await scopeOf(limited)).toEqual(['*']);
  });
});
