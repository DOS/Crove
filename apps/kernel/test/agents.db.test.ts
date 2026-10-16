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
    const runtimeFor = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      const pool = createPool({ connectionString: url.toString(), max: 4 });
      pools.push(pool);
      const db = createDb(pool);
      return { db, runtime: new Runtime(db).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] }) };
    };
    const api = runtimeFor('crove_app', 'test-app-pw');
    app = api.runtime;
    worker = runtimeFor('crove_worker', 'test-worker-pw').runtime;
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
      { title: 'Rà soát đề xuất: Hóa đơn 1', kind: 'proposal_review', tainted: false, status: 'todo' },
      { title: 'Rà soát đề xuất: Hóa đơn 2', kind: 'proposal_review', tainted: false, status: 'todo' },
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
      { title: 'Duyệt đề xuất: Hóa đơn 1', assignee_position_id: null, request_depth: 1, created_by_type: 'agent', created_by_id: agentId },
      { title: 'Duyệt đề xuất: Hóa đơn 2', assignee_position_id: null, request_depth: 1, created_by_type: 'agent', created_by_id: agentId },
    ]);
    expect(after.comments[0]).toEqual({ body: reviewText({ id: first.proposalId, title: 'Hóa đơn 1', status: 'pending', checks }), author_type: 'agent', author_id: agentId });
    expect(after.run).toEqual([{ status: 'succeeded' }]);
    expect(after.wakeups).toEqual([{ status: 'done' }]);
    // checkout, comment and escalate for each task, each on its own agent audit row.
    expect(after.audit.n).toBe(6);

    // The owner sees the escalations as their own tasks, and the chart shows the AI seat.
    const mine = await app.query<{ tasks: Array<{ kind: string }> }>('kernel.task.list', { mine: true }, { actor: asUser(owner), orgId });
    expect(mine.tasks.map((t) => t.kind)).toEqual(['escalation', 'escalation']);
    const chart = await app.query<{ positions: Array<{ id: string; holder: { ai: boolean } | null }> }>('kernel.chart.get', {}, { actor: asUser(owner), orgId });
    expect(chart.positions.find((p) => p.id === positionId)?.holder).toMatchObject({ type: 'agent', agentId, ai: true });

    // Nothing pending: the next wake-up starts no run.
    await expect(runAgentWake({ runtime: worker, programs: financeAgentPrograms }, orgId, agentId)).resolves.toEqual({ runId: null, reason: 'idle' });
  });

  it('keeps a refused wake-up pending and finds it again in the sweep', async () => {
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
    const due = async () =>
      admin(async (c) => {
        const url = new URL(adminUrl);
        url.username = 'crove_worker';
        url.password = 'test-worker-pw';
        const w = new pg.Client({ connectionString: url.toString() });
        await w.connect();
        try {
          return (await w.query<{ org_id: string; agent_id: string }>('SELECT * FROM crove_kernel.agent_wakeups_due(100)')).rows.filter((r) => r.agent_id === agentId);
        } finally {
          await w.end();
          void c;
        }
      });
    expect(await due()).toEqual([]);
    await admin((c) => c.query(`UPDATE crove_kernel.agent_wakeup SET updated_at = now() - interval '2 minutes' WHERE agent_id = $1 AND status = 'pending'`, [agentId]));
    expect(await due()).toEqual([{ org_id: orgId, agent_id: agentId }]);
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
});
