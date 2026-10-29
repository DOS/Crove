// The approval gate in the database (#1793, the P13 residual of #1707; plan §4.7 P09, P10, P12) on PostgreSQL 17, as
// the real login roles. A user's session moves a proposal to 'approved' only through crove_kernel.proposal_approve,
// which decides the approval itself; raw SQL on crove_app is refused in member and agent contexts. The three ways the
// runtime approves still pass: kernel.proposal.approve, kernel.proposal.approve_many and an agent's approval (the
// worker, in the system context). The database's policy table equals approval.ts's. Part of the invariant suite: keep
// it self-contained (package code under test, no helpers from outside test/invariant/). Set CROVE_TEST_ADMIN_URL to a
// superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { sql } from 'kysely';
import { approvalPolicies, createOrg, decideApproval, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, defineCommand, type AgentActor, type CommandDef } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const TEMPLATE = 'finance.chief_accountant';
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const LEDGER_COMMAND = 'finance.voucher.record';
const suite = ADMIN ? describe : describe.skip;

// A preparer agents may run and an R1 proposal command agents with the chief accountant role key may approve.
const prepare1793 = defineCommand({
  name: 't1793.prepare',
  input: z.object({}),
  risk: 'R0',
  access: ['owner', 'admin', 'member'],
  sideEffect: 'none',
  agent: { roles: 'any' },
  writes: [],
  handler: async () => ({ kind: 't1793', command: 't1793.prop', title: 'T1793', payload: { n: 1 } }),
}) as CommandDef<unknown, unknown>;
const proposal1793 = defineCommand({
  name: 't1793.prop',
  input: z.object({ payload: z.unknown(), acceptFailedChecks: z.boolean().optional() }),
  risk: 'R1',
  sideEffect: 'none',
  access: 'proposal',
  agentApprovers: { roles: [TEMPLATE] },
  writes: [],
  handler: async () => ({ executed: 't1793.prop' }),
}) as CommandDef<unknown, unknown>;

suite('the approval gate in the database (#1793)', () => {
  const dbName = `crove_test_approve_gate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let owner = '';
  let second = '';
  let member = '';
  let viewer = '';
  let chief = '';
  let scopedChief = '';
  let removed = '';
  let orgId = '';
  let otherOrg = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const REFUSED = (message: string) => ({ ok: false, code: '42501', message });
  const user = (id: string) => ({ type: 'user' as const, id });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // Runs SQL in a context on a login role, always rolled back.
  async function inContext<T>(url: string, enter: (c: pg.Client) => Promise<unknown>, fn: (c: pg.Client) => Promise<T>) {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enter(c);
      return { ok: true as const, value: await fn(c) };
    } catch (error) {
      const e = error as { code?: string; message: string };
      return { ok: false as const, code: e.code, message: e.message };
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const asMember = <T>(userId: string, fn: (c: pg.Client) => Promise<T>, org = orgId) =>
    inContext(appUrl, (c) => c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, org]), fn);

  // A pending ledger proposal written by staff, with its snapshot and authors.
  async function proposal(snapshot: string[], authors: string[], org = orgId): Promise<string> {
    return admin(async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors)
           VALUES ($1, 't1793', $2, 'T1793', '{}', $3::uuid[], $4) RETURNING id`,
          [org, LEDGER_COMMAND, snapshot, JSON.stringify(authors.map((id) => ({ type: 'user', id })))],
        )
      ).rows[0]?.id as string,
    );
  }
  const gate = (id: string, revision = 1) => (c: pg.Client) =>
    c.query<{ d: Record<string, unknown> }>('SELECT crove_kernel.proposal_approve($1::uuid, $2::int, gen_random_uuid()) AS d', [id, revision]).then((r) => r.rows[0]?.d);
  const statusOf = async (id: string) => (await admin((c) => c.query<{ s: string }>('SELECT status AS s FROM crove_kernel.proposal WHERE id = $1', [id]))).rows[0]?.s;

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
      return new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands, ...financeCommands, prepare1793, proposal1793],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    };
    app = runtimeFor(appUrl);
    worker = runtimeFor(workerUrl);
    const db = createDb(pools[0] as pg.Pool);
    const person = (name: string) => upsertIdentity(db, { issuer: 't1793', subject: randomUUID(), email: `${name}@t1793.test`, name: null });
    owner = await person('owner');
    second = await person('admin');
    member = await person('member');
    viewer = await person('viewer');
    chief = await person('chief');
    scopedChief = await person('scoped-chief');
    removed = await person('removed');
    ({ orgId } = await createOrg(app, asUser(owner), 'T1793'));
    ({ orgId: otherOrg } = await createOrg(app, asUser(owner), 'T1793 khác'));
    await admin(async (c) => {
      for (const [user, role] of [
        [second, 'admin'],
        [member, 'member'],
        [viewer, 'viewer'],
        [chief, 'member'],
        [scopedChief, 'member'],
      ] as const) {
        await c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, user, role]);
      }
      // A chief accountant org-wide (holds the ledger's approval permission) and one limited to the default entity (an
      // entity-scoped assignment grants no approval).
      const entity = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      for (const [user, scope] of [
        [chief, null],
        [scopedChief, entity],
      ] as const) {
        await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'finance.chief_accountant', $3, $4)`, [
          orgId,
          user,
          scope,
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

  it("holds the same policy table as approval.ts, and nobody approves an unknown command", async () => {
    const policies = approvalPolicies();
    expect(policies.length).toBeGreaterThan(0);
    // Every command registered as a proposal command has the same policy on both sides (nobody, when approval.ts lists
    // none), and approval.ts lists no command that is not one: a command added on one side only fails here.
    const registered = [...kernelCommands, ...financeCommands, prepare1793, proposal1793]
      .filter((c) => (c as CommandDef<unknown, unknown>).access === 'proposal')
      .map((c) => c.name);
    expect(registered.length).toBeGreaterThan(policies.length);
    for (const p of policies) expect(registered, `${p.command} is a registered proposal command`).toContain(p.command);
    for (const command of registered) {
      const expected = policies.find((p) => p.command === command) ?? { roles: [], permission: null, fourEyes: true, ledger: false };
      const row = await admin(async (c) =>
        (
          await c.query<{ roles: string[]; permission: string | null; four_eyes: boolean; ledger: boolean }>(
            'SELECT roles, permission, four_eyes, ledger FROM crove_kernel.approval_command_policy($1)',
            [command],
          )
        ).rows[0],
      );
      expect(row, command).toEqual({ roles: [...expected.roles], permission: expected.permission, four_eyes: expected.fourEyes, ledger: expected.ledger });
    }
    for (const p of [...policies, { command: 't1793.unknown', roles: [], permission: null, fourEyes: true, ledger: false }]) {
      const row = await admin(async (c) =>
        (
          await c.query<{ roles: string[]; permission: string | null; four_eyes: boolean; ledger: boolean }>(
            'SELECT roles, permission, four_eyes, ledger FROM crove_kernel.approval_command_policy($1)',
            [p.command],
          )
        ).rows[0],
      );
      expect(row, p.command).toEqual({ roles: [...p.roles], permission: p.permission, four_eyes: p.fourEyes, ledger: p.ledger });
    }
  });

  it('decides every case exactly as decideApproval does (P09 presets, P10, P12, a removed member, not pending)', { timeout: 300_000 }, async () => {
    const db = createDb(pools[0] as pg.Pool);
    const snapshots = [[owner, second, chief, scopedChief, viewer, member], [owner], [owner, removed], [chief], [second, chief]];
    const authorSets: unknown[][] = [
      [],
      [user(owner)],
      [user(owner), user(second), user(chief)],
      [user(second)],
      [{ type: 'agent', id: randomUUID(), run: randomUUID() }],
      // Malformed entries: a missing id, component or run, an id zod's z.uuid() refuses (not RFC 9562), an id in capitals.
      [{ type: 'user' }],
      [{ type: 'system' }],
      [{ type: 'agent', id: randomUUID() }],
      [user(owner), user('00000000-0000-0000-0000-000000000001')],
      [user(owner), { type: 'user', id: randomUUID().toUpperCase() }],
      [{ type: 'user', id: owner.toUpperCase() }],
      [user(owner), { type: 'system', component: 'finance.extract' }],
    ];
    const actors = [owner, second, member, viewer, chief, scopedChief];
    const cases: Array<{ preset: string; command: string; status: string; snapshot: string[]; authors: unknown[] }> = [];
    for (const preset of ['founder', 'accountant']) {
      for (const snapshot of snapshots) for (const authors of authorSets) cases.push({ preset, command: LEDGER_COMMAND, status: 'pending', snapshot, authors });
      cases.push({ preset, command: 't1793.unknown', status: 'pending', snapshot: [owner], authors: [] });
      cases.push({ preset, command: LEDGER_COMMAND, status: 'executed', snapshot: [owner], authors: [] });
      cases.push({ preset, command: LEDGER_COMMAND, status: 'pending', snapshot: [], authors: [] });
    }
    // One staff connection for the whole table.
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    try {
      let checked = 0;
      for (const c of cases) {
        await a.query('UPDATE crove_kernel.tenant SET approval_preset = $2 WHERE org_id = $1', [orgId, c.preset]);
        for (const actor of actors) {
          const ts = await db.transaction().execute(async (trx) => {
            await sql`SELECT crove_kernel.enter_context(${actor}::uuid, ${orgId}::uuid)`.execute(trx);
            return decideApproval(trx, orgId, asUser(actor), { command: c.command, status: c.status, eligible_approvers: c.snapshot, authors: c.authors }, { lock: false });
          });
          const inDb = (
            await a.query<{ d: { reason: string; eligibleCount: number; selfApproved: boolean; fourEyes: string; preset: string; version: number } }>(
              'SELECT crove_kernel.proposal_approval_decide($1::uuid, $2, $3, $4::uuid[], $5::jsonb, $6::uuid, false) AS d',
              [orgId, c.command, c.status, c.snapshot, JSON.stringify(c.authors), actor],
            )
          ).rows[0]?.d;
          const where = JSON.stringify({ ...c, actor });
          expect(
            { reason: inDb?.reason, eligibleCount: inDb?.eligibleCount, selfApproved: inDb?.selfApproved, fourEyes: inDb?.fourEyes, orgPolicy: { preset: inDb?.preset, version: inDb?.version } },
            where,
          ).toEqual({ reason: ts.reason, eligibleCount: ts.eligibleCount, selfApproved: ts.selfApproved, fourEyes: ts.fourEyes, orgPolicy: ts.orgPolicy });
          checked += 1;
        }
      }
      expect(checked).toBe(cases.length * actors.length);
    } finally {
      await a.query(`UPDATE crove_kernel.tenant SET approval_preset = 'founder' WHERE org_id = $1`, [orgId]);
      await a.end();
    }
  });

  it('refuses raw SQL that moves a proposal to approved in a member or an agent context, and lets the system context', async () => {
    const id = await proposal([owner, second], []);
    const forge = (c: pg.Client) =>
      c.query(`UPDATE crove_kernel.proposal SET status = 'approved', decided_by = $2, decided_at = now(), executed_command_id = gen_random_uuid() WHERE id = $1`, [id, owner]);
    for (const user of [owner, second, member, viewer]) {
      await expect(asMember(user, forge), user).resolves.toMatchObject({ ok: false, code: '23514', message: 'PROPOSAL_STATUS_TRANSITION' });
    }
    // An agent context writes no proposal at all.
    const { agentId, positionId } = await app.execute<{ agentId: string; positionId: string }>('kernel.agent.template.install', { templateKey: TEMPLATE }, { actor: asMfa(owner), orgId });
    await app.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId }, { actor: SYSTEM, orgId });
    const agent: AgentActor = { type: 'agent', agentId, runId: started.runId as string };
    const inAgent = await inContext(workerUrl, (c) => c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agent.agentId, agent.runId]), forge);
    expect(inAgent).toMatchObject({ ok: false, code: '42501', message: 'AGENT_FORBIDDEN' });
    // The worker's login may not call the gate at all (only the API's may).
    const viaGate = await inContext(workerUrl, (c) => c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agent.agentId, agent.runId]), gate(id));
    expect(viaGate).toMatchObject({ ok: false, code: '42501', message: expect.stringMatching(/permission denied for function proposal_approve/) });
    // The worker's system context, which executes an agent's approval, still moves it itself.
    const system = await inContext(workerUrl, (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]), forge);
    expect(system).toMatchObject({ ok: true });
    expect(await statusOf(id)).toBe('pending');
  });

  it('keeps what P10 and P12 stand on: no rewritten authors, snapshot or command, no forged pending insert', async () => {
    const authored = await proposal([owner, second], [owner]);
    for (const [what, text, values] of [
      ['authors cleared', `UPDATE crove_kernel.proposal SET authors = '[]' WHERE id = $1`, [authored]],
      ['snapshot narrowed', 'UPDATE crove_kernel.proposal SET eligible_approvers = ARRAY[$2::uuid] WHERE id = $1', [authored, owner]],
      ['command changed', `UPDATE crove_kernel.proposal SET command = 'finance.journal.reverse' WHERE id = $1`, [authored]],
    ] as const) {
      await expect(asMember(owner, (c) => c.query(text, [...values])), what).resolves.toMatchObject({ ok: false, code: '23514', message: 'PROPOSAL_STATUS_TRANSITION' });
    }
    // Authors may grow, as an edit adds its editor.
    await expect(
      asMember(second, (c) => c.query(`UPDATE crove_kernel.proposal SET authors = authors || jsonb_build_array(jsonb_build_object('type', 'user', 'id', $2::text)) WHERE id = $1`, [authored, second])),
    ).resolves.toMatchObject({ ok: true });
    // A user's pending insert names itself among the authors and the snapshot of now.
    const eligibleNow = [owner, second, chief].sort();
    const insert = (snapshot: string[], authors: unknown[]) => (c: pg.Client) =>
      c.query(
        `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors)
         VALUES ($1, 't1793', $2, 'T1793', '{}', $3::uuid[], $4)`,
        [orgId, LEDGER_COMMAND, snapshot, JSON.stringify(authors)],
      );
    // A narrowed snapshot is replaced by the database's own.
    const recorded = await asMember(owner, async (c) => {
      await insert([owner], [user(owner)])(c);
      return (await c.query<{ s: string[] }>(`SELECT eligible_approvers::text[] AS s FROM crove_kernel.proposal WHERE org_id = $1 AND title = 'T1793' ORDER BY created_at DESC, id DESC LIMIT 1`, [orgId])).rows[0]?.s;
    });
    expect(recorded.ok && [...(recorded.value ?? [])].sort()).toEqual(eligibleNow);
    await expect(asMember(owner, insert(eligibleNow, []))).resolves.toMatchObject({ ok: false, code: '23514', message: 'PROPOSAL_STATUS_TRANSITION' });
    await expect(asMember(owner, insert(eligibleNow, [user(second)]))).resolves.toMatchObject({ ok: false, code: '23514', message: 'PROPOSAL_STATUS_TRANSITION' });
    await expect(asMember(member, insert(eligibleNow, [user(member)]))).resolves.toMatchObject({ ok: true });
  });

  it('decides P12, P10 and P09 in the gate itself, whoever calls it', async () => {
    // Eligible and not an author: approved, in the caller's transaction.
    const plain = await proposal([owner, second], []);
    await expect(asMember(owner, gate(plain))).resolves.toMatchObject({ ok: true, value: { fourEyes: 'pass', selfApproved: false, eligibleCount: 2 } });
    // Not in the snapshot or no approving role: a member, a viewer, someone of another org.
    for (const user of [member, viewer]) await expect(asMember(user, gate(plain)), user).resolves.toMatchObject(REFUSED('NOT_ELIGIBLE'));
    // Another org's proposal, an unknown one, a stale revision.
    await expect(asMember(owner, gate(plain), otherOrg)).resolves.toMatchObject(REFUSED('NOT_FOUND'));
    await expect(asMember(owner, gate(randomUUID()))).resolves.toMatchObject(REFUSED('NOT_FOUND'));
    await expect(asMember(owner, gate(plain, 2))).resolves.toMatchObject(REFUSED('STALE_REVISION'));
    // P10: an author with another eligible approver may not; the sole eligible approver may (self_approved); an owner
    // when every eligible approver is an author (owner_override), an admin then may not.
    await expect(asMember(owner, gate(await proposal([owner, second], [owner])))).resolves.toMatchObject(REFUSED('FOUR_EYES_REQUIRED'));
    await expect(asMember(owner, gate(await proposal([owner], [owner])))).resolves.toMatchObject({ ok: true, value: { fourEyes: 'self_approved' } });
    const everyone = await proposal([owner, second], [owner, second]);
    await expect(asMember(owner, gate(everyone))).resolves.toMatchObject({ ok: true, value: { fourEyes: 'owner_override' } });
    await expect(asMember(second, gate(everyone))).resolves.toMatchObject(REFUSED('FOUR_EYES_REQUIRED'));
    // Authors not recorded: fail closed.
    const unrecorded = await admin(async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors)
           VALUES ($1, 't1793', $2, 'T1793', '{}', ARRAY[$3::uuid], '[{"type": "user"}]') RETURNING id`,
          [orgId, LEDGER_COMMAND, owner],
        )
      ).rows[0]?.id as string,
    );
    await expect(asMember(owner, gate(unrecorded))).resolves.toMatchObject(REFUSED('NOT_ELIGIBLE'));
    // P09: under the accountant preset only a holder of the approval permission approves a ledger proposal.
    await admin((c) => c.query(`UPDATE crove_kernel.tenant SET approval_preset = 'accountant' WHERE org_id = $1`, [otherOrg]));
    const ledger = await proposal([owner], [], otherOrg);
    await expect(asMember(owner, gate(ledger), otherOrg)).resolves.toMatchObject(REFUSED('NOT_ELIGIBLE'));
    // Nothing above committed.
    for (const id of [plain, everyone]) expect(await statusOf(id)).toBe('pending');
  });

  it('still approves through kernel.proposal.approve, approve_many and an agent approval', async () => {
    const voucher = () => ({
      command: 'finance.journal_voucher.record',
      input: {
        date: '2026-10-05',
        description: 'Trích trước tiền điện',
        lines: [
          { account: '6422', debit: '450000', credit: '0' },
          { account: '3388', debit: '0', credit: '450000' },
        ],
      },
    });
    const ask = async () => (await app.execute<{ proposalId: string }>('kernel.proposal.request', voucher(), { actor: asUser(member), orgId, idempotencyKey: randomUUID() })).proposalId;
    const revisionOf = async (id: string) => (await app.query<{ revision: number }>('kernel.inbox.get', { id }, { actor: asUser(owner), orgId })).revision;

    const one = await ask();
    await app.execute('kernel.proposal.approve', { id: one, revision: await revisionOf(one) }, { actor: asMfa(owner), orgId });
    expect(await statusOf(one)).toBe('executed');

    const [a, b] = [await ask(), await ask()];
    const items = [
      { id: a, revision: await revisionOf(a) },
      { id: b, revision: await revisionOf(b) },
    ];
    await app.execute('kernel.proposal.approve_many', { items }, { actor: asMfa(second), orgId });
    expect([await statusOf(a), await statusOf(b)]).toEqual(['executed', 'executed']);

    // An agent asks for a proposal from its task; another agent approves it from a review task; the worker executes it.
    const liveAgent = async () => {
      const { agentId, positionId } = await app.execute<{ agentId: string; positionId: string }>('kernel.agent.template.install', { templateKey: TEMPLATE }, { actor: asMfa(owner), orgId });
      const { taskId } = await app.execute<{ taskId: string }>('kernel.task.create', { title: 'Việc thử', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
      const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId }, { actor: SYSTEM, orgId });
      return { actor: { type: 'agent' as const, agentId, runId: started.runId as string }, positionId, taskId };
    };
    const newest = async (type: string) =>
      (await admin((c) => c.query<{ id: string }>('SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = $2 ORDER BY id DESC LIMIT 1', [orgId, type]))).rows[0]
        ?.id as string;
    const requester = await liveAgent();
    const asked = { actor: requester.actor, orgId };
    const lease = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: requester.taskId }, asked);
    await worker.execute('kernel.task.propose', { id: requester.taskId, fence: lease.fence, preparer: 't1793.prepare', input: {} }, asked);
    const created = await worker.execute<{ proposalId: string | null }>('kernel.agent.proposal.create', { eventId: await newest('kernel.agent.proposal_requested') }, { actor: SYSTEM, orgId });
    const agentProposal = created.proposalId as string;
    const approver = await liveAgent();
    const review = await admin(async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, kind, assignee_position_id, source, source_ref, created_by_type)
           VALUES ($1, 'Duyệt', 'proposal_review', $2, 'event', $3, 'system') RETURNING id`,
          [orgId, approver.positionId, JSON.stringify({ type: 'kernel.proposal', id: agentProposal })],
        )
      ).rows[0]?.id as string,
    );
    const as = { actor: approver.actor, orgId };
    const reviewLease = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: review }, as);
    await worker.execute('kernel.task.approve_proposal', { id: review, fence: reviewLease.fence, proposalId: agentProposal, revision: 1 }, as);
    await expect(worker.execute('kernel.agent.proposal.approve', { eventId: await newest('kernel.agent.proposal_approved') }, { actor: SYSTEM, orgId })).resolves.toEqual({
      approved: true,
      reason: null,
    });
    expect(await statusOf(agentProposal)).toBe('executed');
  });
});
