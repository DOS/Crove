// Proposals per legal entity and agents' position scopes (#1538, plan §4.6, owner decision 2026-10-29, option (b)) on
// PostgreSQL 17, as the real login roles: the API role (crove_app) for users, the worker role (crove_worker) for system
// and agent actors.
//   - Positions written before 20261104010000 get the scope '{*}'; a new position gets the org's default entity
//     unless its owner names '{*}' or entities of the org; anything else is refused.
//   - A member limited to one entity sees and asks for only that entity's proposals in the Inbox.
//   - An agent sees only the proposals of its position's entities, gets review tasks for those only, records and has
//     executed approvals of those only (the worker decides again after the owner narrows the scope), and the worker
//     creates its proposals only in those entities.
// Part of the invariant suite: keep it self-contained (package code under test, no helpers from outside
// test/invariant/). Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, defineCommand, type AgentActor, type CommandDef, type InputHashMode } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const THIS_VERSION = '20261104010000';
const TEMPLATE = 'finance.chief_accountant';
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const suite = ADMIN ? describe : describe.skip;

// A preparer agents may run (it writes nothing), which names the entity it is given, and an R1 proposal command agents
// with the chief accountant role key may approve.
const prepare1538 = defineCommand({
  sideEffect: 'none',
  name: 't1538.prepare',
  input: z.object({ legalEntityId: z.string().optional() }),
  risk: 'R0',
  access: ['owner', 'admin', 'member'],
  agent: { roles: 'any' },
  // It writes no table (#1710: a command an agent may run declares its writes).
  writes: [],
  handler: async (_ctx, input) => ({ kind: 't1538', command: 't1538.prop', title: 'T1538', payload: input.legalEntityId ? { legalEntityId: input.legalEntityId } : { n: 1 } }),
}) as CommandDef<unknown, unknown>;
const proposal1538 = defineCommand({
  sideEffect: 'none',
  name: 't1538.prop',
  input: z.object({ payload: z.unknown(), acceptFailedChecks: z.boolean().optional() }),
  risk: 'R1',
  access: 'proposal',
  agentApprovers: { roles: [TEMPLATE] },
  writes: [],
  handler: async () => ({ executed: 't1538.prop' }),
}) as CommandDef<unknown, unknown>;

suite('proposals per legal entity and agent position scopes on PostgreSQL (#1538)', () => {
  const dbName = `crove_test_proposal_le_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let before = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let owner = '';
  let accountantA = '';
  let accountantB = '';
  let orgId = '';
  let defaultEntity = '';
  let branch = '';
  let legacyPosition = '';
  let legacyProposal = '';
  let legacyBranchProposal = '';

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

  // Runs SQL as crove_worker inside the agent's context, always rolled back.
  async function inAgentContext<T>(actor: AgentActor, fn: (c: pg.Client) => Promise<T>): Promise<T> {
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

  function connect(inputHash: InputHashMode = 'keyed') {
    const runtimeFor = (url: string) => {
      const pool = createPool({ connectionString: url, max: 4 });
      pools.push(pool);
      return new Runtime(createDb(pool), { manifests: TEST_MANIFESTS, inputHash }).register({
        commands: [...kernelCommands, ...financeCommands, prepare1538, proposal1538],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    };
    app = runtimeFor(appUrl);
    worker = runtimeFor(workerUrl);
  }

  // An agent installed from the template with the given scope (none named: the default), holding its own top-level
  // position, with a live run started through a task that wakes it.
  async function liveAgent(leScope?: string[]) {
    const { agentId, positionId } = await app.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: TEMPLATE, ...(leScope ? { leScope } : {}) },
      { actor: asMfa(owner), orgId },
    );
    const { taskId } = await app.execute<{ taskId: string }>('kernel.task.create', { title: 'Việc thử', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId }, { actor: SYSTEM, orgId });
    if (!started.runId) throw new Error('no run');
    const actor: AgentActor = { type: 'agent', agentId, runId: started.runId };
    return { actor, agentId, positionId, taskId, runId: started.runId };
  }

  const scopeOf = async (positionId: string) =>
    admin(async (c) => (await c.query<{ s: string[] }>('SELECT le_scope AS s FROM crove_kernel.position WHERE id = $1', [positionId])).rows[0]?.s);

  async function newestEvent(type: string): Promise<string> {
    return admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = $2 ORDER BY id DESC LIMIT 1', [orgId, type])).rows[0]?.id as string);
  }

  // An agent asks for a proposal from its own task, and the worker creates it.
  async function agentProposes(agent: Awaited<ReturnType<typeof liveAgent>>, legalEntityId?: string) {
    const as = { actor: agent.actor, orgId };
    const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: agent.taskId }, as);
    await worker.execute('kernel.task.propose', { id: agent.taskId, fence, preparer: 't1538.prepare', input: legalEntityId ? { legalEntityId } : {} }, as);
    const eventId = await newestEvent('kernel.agent.proposal_requested');
    return worker.execute<{ proposalId: string | null; reason: string | null }>('kernel.agent.proposal.create', { eventId }, { actor: SYSTEM, orgId });
  }

  // A review task as kernel.agent.dispatch_event creates it (system, kind 'proposal_review').
  async function reviewTaskFor(positionId: string, proposalId: string): Promise<string> {
    return admin(async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, kind, assignee_position_id, source, source_ref, created_by_type)
           VALUES ($1, 'Duyệt', 'proposal_review', $2, 'event', $3, 'system') RETURNING id`,
          [orgId, positionId, JSON.stringify({ type: 'kernel.proposal', id: proposalId })],
        )
      ).rows[0]?.id as string,
    );
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    // The database as it was before this migration.
    before = mkdtempSync(join(tmpdir(), 'crove-proposal-le-before-'));
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n.slice(0, 14) < THIS_VERSION)) {
      copyFileSync(join(MIGRATIONS, name), join(before, name));
    }
    await migrate({ adminUrl, dir: before });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    connect();

    const db = createDb(pools[0] as pg.Pool);
    const person = (name: string) => upsertIdentity(db, { issuer: 't1538', subject: randomUUID(), email: `${name}@t1538.test`, name: null });
    owner = await person('owner');
    accountantA = await person('accountant-a');
    accountantB = await person('accountant-b');
    ({ orgId } = await createOrg(app, asUser(owner), 'T1538'));
    await admin(async (c) => {
      defaultEntity = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      branch = (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner])
      ).rows[0]?.id as string;
      for (const [user, entity] of [
        [accountantA, defaultEntity],
        [accountantB, branch],
      ] as const) {
        await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, user]);
        await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
          orgId,
          user,
          entity,
          owner,
        ]);
      }
      // Written before the migration: a position with the old empty scope, and a proposal left without an entity (the
      // stamp's trigger off, as for a row a writer limited to other entities left without one).
      legacyPosition = (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.position (org_id, title, module, role_key) VALUES ($1, 'Cũ', 'finance', $2) RETURNING id`, [orgId, TEMPLATE])
      ).rows[0]?.id as string;
      await c.query('ALTER TABLE crove_kernel.proposal DISABLE TRIGGER b_legal_entity');
      legacyProposal = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors)
           VALUES ($1, 't1538', 't1538.prop', 'Cũ', '{}', ARRAY[$2::uuid], '[]') RETURNING id`,
          [orgId, owner],
        )
      ).rows[0]?.id as string;
      await c.query('ALTER TABLE crove_kernel.proposal ENABLE ALWAYS TRIGGER b_legal_entity');
      // A branch's voucher asked for before the migration: its payload names the branch, its stamp the default entity.
      legacyBranchProposal = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors)
           VALUES ($1, 't1538', 't1538.prop', 'Chi nhánh cũ', $3, ARRAY[$2::uuid], '[]') RETURNING id`,
          [orgId, owner, JSON.stringify({ legalEntityId: branch.toUpperCase() })],
        )
      ).rows[0]?.id as string;
    });
    const stampedBefore = await admin(async (c) => (await c.query<{ e: string }>('SELECT legal_entity_id AS e FROM crove_kernel.proposal WHERE id = $1', [legacyBranchProposal])).rows[0]?.e);
    expect(stampedBefore).toBe(defaultEntity);
    expect(await scopeOf(legacyPosition)).toEqual([]);

    await migrate({ adminUrl, dir: MIGRATIONS });
    // Connections opened before the migration may hold plans of the tables as they were.
    for (const pool of pools.splice(0)) await pool.end();
    connect();
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (before) rmSync(before, { recursive: true, force: true });
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("gives positions written before the migration every entity, a proposal the entity its payload names, and one left without any the default entity", async () => {
    expect(await scopeOf(legacyPosition)).toEqual(['*']);
    const entityOf = (id: string) => admin(async (c) => (await c.query<{ e: string }>('SELECT legal_entity_id AS e FROM crove_kernel.proposal WHERE id = $1', [id])).rows[0]?.e);
    expect(await entityOf(legacyProposal)).toBe(defaultEntity);
    expect(await entityOf(legacyBranchProposal)).toBe(branch);
    // The branch's accountant still sees its branch's proposal written before the migration.
    const seen = (await app.query<Array<{ id: string }>>('kernel.inbox.list', {}, { actor: asUser(accountantB), orgId })).map((p) => p.id);
    expect(seen).toContain(legacyBranchProposal);
    expect(seen).not.toContain(legacyProposal);
    await expect(admin((c) => c.query('UPDATE crove_kernel.proposal SET legal_entity_id = $2 WHERE id = $1', [legacyProposal, branch]))).rejects.toThrow(/LEGAL_ENTITY_IMMUTABLE/);
  });

  it("scopes a new position to the default entity unless the owner names '*' or entities of the org, and refuses anything else", async () => {
    const plain = await app.execute<{ positionId: string }>('kernel.position.create', { title: 'Mặc định', module: 'finance', roleKey: TEMPLATE }, { actor: asMfa(owner), orgId });
    expect(await scopeOf(plain.positionId)).toEqual([defaultEntity]);
    const wide = await app.execute<{ positionId: string }>('kernel.position.create', { title: 'Mọi nơi', module: 'finance', roleKey: TEMPLATE, leScope: ['*'] }, { actor: asMfa(owner), orgId });
    expect(await scopeOf(wide.positionId)).toEqual(['*']);
    await app.execute('kernel.position.update', { id: wide.positionId, leScope: [branch] }, { actor: asMfa(owner), orgId });
    expect(await scopeOf(wide.positionId)).toEqual([branch]);
    const installed = await app.execute<{ positionId: string }>('kernel.agent.template.install', { templateKey: TEMPLATE, leScope: [branch, defaultEntity] }, { actor: asMfa(owner), orgId });
    expect(new Set(await scopeOf(installed.positionId))).toEqual(new Set([branch, defaultEntity]));

    // The commands refuse another org's or an unknown entity, and the same entity twice.
    const { orgId: other } = await createOrg(app, asUser(owner), 'T1538 khác');
    const otherEntity = await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1', [other])).rows[0]?.id as string);
    for (const leScope of [[otherEntity], [randomUUID()], [branch, branch]]) {
      await expect(app.execute('kernel.position.update', { id: plain.positionId, leScope }, { actor: asMfa(owner), orgId }), JSON.stringify(leScope)).rejects.toMatchObject({
        code: 'POSITION_SCOPE_INVALID',
      });
    }
    // The input refuses '*' beside an entity, an empty scope and anything that is not an id.
    for (const leScope of [['*', branch], [], ['branch']]) {
      await expect(app.execute('kernel.position.update', { id: plain.positionId, leScope }, { actor: asMfa(owner), orgId }), JSON.stringify(leScope)).rejects.toMatchObject({
        code: 'VALIDATION',
      });
    }
    // The database refuses them too, whoever writes.
    for (const scope of [['*', branch], [otherEntity], [branch, branch], [branch.toUpperCase()], ['x']]) {
      await expect(admin((c) => c.query('UPDATE crove_kernel.position SET le_scope = $2 WHERE id = $1', [plain.positionId, scope])), JSON.stringify(scope)).rejects.toThrow(
        /POSITION_SCOPE_INVALID/,
      );
    }
    expect(await scopeOf(plain.positionId)).toEqual([defaultEntity]);
    // Only an owner sets a scope; no agent writes a position (T18).
    await expect(app.execute('kernel.position.update', { id: plain.positionId, leScope: ['*'] }, { actor: asUser(accountantB), orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("shows a member limited to one entity only that entity's proposals in the Inbox, and lets it ask for one there only", async () => {
    const voucher = (legalEntityId: string) => ({
      command: 'finance.journal_voucher.record',
      input: {
        date: '2026-10-05',
        description: 'Trích trước tiền điện',
        lines: [
          { account: '6422', debit: '450000', credit: '0' },
          { account: '3388', debit: '0', credit: '450000' },
        ],
        legalEntityId,
      },
    });
    const ofBranch = await app.execute<{ proposalId: string }>('kernel.proposal.request', voucher(branch), { actor: asUser(accountantB), orgId, idempotencyKey: randomUUID() });
    const ofDefault = await app.execute<{ proposalId: string }>('kernel.proposal.request', voucher(defaultEntity), { actor: asUser(owner), orgId, idempotencyKey: randomUUID() });
    const stamped = await admin(async (c) =>
      Object.fromEntries(
        (await c.query<{ id: string; e: string }>('SELECT id, legal_entity_id AS e FROM crove_kernel.proposal WHERE id = ANY($1::uuid[])', [[ofBranch.proposalId, ofDefault.proposalId]])).rows.map(
          (r) => [r.id, r.e],
        ),
      ),
    );
    expect(stamped).toEqual({ [ofBranch.proposalId]: branch, [ofDefault.proposalId]: defaultEntity });

    const inbox = async (userId: string) => (await app.query<Array<{ id: string }>>('kernel.inbox.list', {}, { actor: asUser(userId), orgId })).map((p) => p.id);
    const seenByB = await inbox(accountantB);
    expect(seenByB).toContain(ofBranch.proposalId);
    expect(seenByB).not.toContain(ofDefault.proposalId);
    const seenByA = await inbox(accountantA);
    expect(seenByA).toContain(ofDefault.proposalId);
    expect(seenByA).not.toContain(ofBranch.proposalId);
    expect(await inbox(owner)).toEqual(expect.arrayContaining([ofBranch.proposalId, ofDefault.proposalId]));
    await expect(app.query('kernel.inbox.get', { id: ofDefault.proposalId }, { actor: asUser(accountantB), orgId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(app.query('kernel.proposal.timeline', { id: ofDefault.proposalId }, { actor: asUser(accountantB), orgId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(app.execute('kernel.proposal.reject', { id: ofDefault.proposalId, reason: 'không phải của tôi' }, { actor: asUser(accountantB), orgId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // Its proposal's activity rows are the branch's too.
    const rows = await admin(async (c) =>
      (await c.query<{ e: string | null }>(`SELECT legal_entity_id AS e FROM crove_kernel.activity WHERE record_type = 'kernel.proposal' AND record_id = $1`, [ofBranch.proposalId])).rows.map(
        (r) => r.e,
      ),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((e) => e === branch)).toBe(true);
    // A member limited to the branch cannot put a proposal in another entity, through the command or in SQL.
    await expect(app.execute('kernel.proposal.request', voucher(defaultEntity), { actor: asUser(accountantB), orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("lets an agent see, review and approve only the proposals of its position's entities", async () => {
    const requester = await liveAgent(['*']);
    const ofDefault = await agentProposes(requester);
    const requesterAgain = await liveAgent(['*']);
    const ofBranch = await agentProposes(requesterAgain, branch);
    expect(ofDefault.proposalId).not.toBeNull();
    expect(ofBranch.proposalId).not.toBeNull();
    const stamped = await admin(async (c) =>
      Object.fromEntries(
        (await c.query<{ id: string; e: string }>('SELECT id, legal_entity_id AS e FROM crove_kernel.proposal WHERE id = ANY($1::uuid[])', [[ofDefault.proposalId, ofBranch.proposalId]])).rows.map(
          (r) => [r.id, r.e],
        ),
      ),
    );
    expect(stamped).toEqual({ [ofDefault.proposalId as string]: defaultEntity, [ofBranch.proposalId as string]: branch });

    const approver = await liveAgent([branch]);
    // Reads: the branch's proposal only.
    const visible = await inAgentContext(approver.actor, async (c) =>
      (await c.query<{ id: string }>('SELECT id FROM crove_kernel.proposal WHERE id = ANY($1::uuid[])', [[ofDefault.proposalId, ofBranch.proposalId]])).rows.map((r) => r.id),
    );
    expect(visible).toEqual([ofBranch.proposalId]);

    // Inbox triage: a review task for the agents whose scope covers the proposal's entity, none for the others.
    const newestCreated = (proposalId: string) =>
      admin(
        async (c) =>
          (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.proposal.created' AND payload->>'proposalId' = $2`, [orgId, proposalId]))
            .rows[0]?.id as string,
      );
    const reviews = async (proposalId: string) => {
      await worker.execute('kernel.agent.dispatch_event', { eventId: await newestCreated(proposalId) }, { actor: SYSTEM, orgId });
      return admin(async (c) =>
        (
          await c.query<{ p: string }>(`SELECT assignee_position_id AS p FROM crove_kernel.task WHERE org_id = $1 AND kind = 'proposal_review' AND source_ref->>'id' = $2`, [
            orgId,
            proposalId,
          ])
        ).rows.map((r) => r.p),
      );
    };
    expect(await reviews(ofDefault.proposalId as string)).not.toContain(approver.positionId);
    expect(await reviews(ofBranch.proposalId as string)).toContain(approver.positionId);

    // Approvals: refused for the default entity's proposal (the agent cannot read it), recorded and executed for the
    // branch's.
    const as = { actor: approver.actor, orgId };
    const outside = await reviewTaskFor(approver.positionId, ofDefault.proposalId as string);
    // The task takes its proposal's entity (#1762), so the agent cannot even check it out.
    await expect(worker.execute('kernel.task.checkout', { id: outside }, as)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    const inside = await reviewTaskFor(approver.positionId, ofBranch.proposalId as string);
    const lease = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: inside }, as);
    await worker.execute('kernel.task.approve_proposal', { id: inside, fence: lease.fence, proposalId: ofBranch.proposalId, revision: 1 }, as);
    const approved = await newestEvent('kernel.agent.proposal_approved');

    // The owner narrows the agent's scope before the worker executes the approval: the worker decides again, and
    // refuses it (P12).
    await app.execute('kernel.position.update', { id: approver.positionId, leScope: [defaultEntity] }, { actor: asMfa(owner), orgId });
    await expect(worker.execute('kernel.agent.proposal.approve', { eventId: approved }, { actor: SYSTEM, orgId })).resolves.toEqual({ approved: false, reason: 'not_eligible' });
    await app.execute('kernel.position.update', { id: approver.positionId, leScope: [branch] }, { actor: asMfa(owner), orgId });
    await expect(worker.execute('kernel.agent.proposal.approve', { eventId: approved }, { actor: SYSTEM, orgId })).resolves.toEqual({ approved: true, reason: null });
    const status = await admin(async (c) => (await c.query<{ status: string; agent: string }>('SELECT status, decided_by_agent AS agent FROM crove_kernel.proposal WHERE id = $1', [ofBranch.proposalId])).rows[0]);
    expect(status).toEqual({ status: 'executed', agent: approver.agentId });
  });

  it("creates an agent's proposal only in its position's entities", async () => {
    const scoped = await liveAgent([branch]);
    // Its preparer names the default entity, which its position leaves out: the worker creates nothing.
    await expect(agentProposes(scoped, defaultEntity)).resolves.toEqual({ proposalId: null, reason: 'out_of_scope' });
    // Naming none means the default entity: refused too.
    const again = await liveAgent([branch]);
    await expect(agentProposes(again)).resolves.toEqual({ proposalId: null, reason: 'out_of_scope' });
    // Naming its own entity works.
    const third = await liveAgent([branch]);
    const made = await agentProposes(third, branch);
    expect(made.proposalId).not.toBeNull();
  });
});
