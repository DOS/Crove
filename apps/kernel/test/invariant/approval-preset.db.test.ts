// The org's approval policy preset (issue #1402, plan §4.7) on a real PostgreSQL 17: the presets are read-only data
// rows; only an owner switches the preset, with fresh MFA, through the audited command, and never to the accountant
// preset while nobody holds the chief accountant role; any other write of the preset or its version is refused by the
// database; under the accountant preset only the chief accountant approves the ledger's proposals (P09), including a
// proposal raised before the switch; and the approval audit row names the rules, the org's preset and version, and the
// build it ran under.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
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
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader'];
const suite = ADMIN ? describe : describe.skip;

type Actor = { type: 'user'; userId: string; aal: 'aal1' | 'aal2'; sessionId?: string; mfaAt?: number };

suite('approval policy presets on PostgreSQL (#1402)', () => {
  const dbName = `crove_test_presets_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  // The worker login role's runtime, where agents run.
  let worker: Runtime;
  let workerPool: pg.Pool;
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

  // Runs fn as the API login role in the user's sealed context of the org, then commits (so deferred triggers run).
  async function committedInContext(userId: string, orgId: string, fn: (c: pg.Client) => Promise<void>): Promise<void> {
    const app = await connect(appUrl);
    await app.query('BEGIN');
    try {
      await app.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      await fn(app);
      await app.query('COMMIT');
    } catch (error) {
      await app.query('ROLLBACK');
      throw error;
    }
  }

  const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@presets.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Presets ${randomUUID().slice(0, 6)}`);
    const [admin, chief] = [await person('admin'), await person('chief')];
    await withAdmin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [orgId, admin, chief]));
    const exec = <T>(actor: Actor, command: string, input: unknown) => rt.execute<T>(command, input, { actor, orgId, idempotencyKey: randomUUID() });
    const setPreset = (actor: Actor, preset: string) => exec<{ preset: string; version: number }>(actor, 'kernel.org.set_approval_preset', { preset });
    const policy = () =>
      withAdmin(
        async (c) =>
          (await c.query<{ preset: string; version: number }>('SELECT approval_preset AS preset, approval_policy_version AS version FROM crove_kernel.tenant WHERE org_id = $1', [orgId]))
            .rows[0],
      );
    // An entry posted through the posting path as the API login role, and a proposal to reverse it raised by `requester`
    // (the owner unless given), who is then its author.
    const proposal = async (requester: string = owner) => {
      let entryId = '';
      await committedInContext(owner, orgId, async (app) => {
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
        entryId = rows[0]?.id as string;
      });
      return (
        await exec<{ proposalId: string }>(asUser(requester), 'kernel.proposal.request', {
          command: 'finance.journal.reverse',
          input: { entryId, entryDate: '2026-10-15', reason: 'Ghi nhầm' },
        })
      ).proposalId;
    };
    const approve = (actor: Actor, id: string) => exec<{ journalEntryId: string }>(actor, 'kernel.proposal.approve', { id, revision: 1 });
    const snapshot = async (id: string) =>
      withAdmin(async (c) => (await c.query<{ e: string[] }>('SELECT eligible_approvers AS e FROM crove_kernel.proposal WHERE id = $1', [id])).rows[0]?.e ?? []);
    const audit = async (command: string, targetOrDetail: string | null = null) =>
      withAdmin(
        async (c) =>
          (
            await c.query<{ detail: Record<string, unknown> }>(
              `SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = 'ok' AND ($3::uuid IS NULL OR target_id = $3::uuid)
               ORDER BY occurred_at DESC, id DESC LIMIT 1`,
              [orgId, command, targetOrDetail],
            )
          ).rows[0]?.detail,
      );
    return { orgId, owner, admin, chief, exec, setPreset, policy, proposal, approve, snapshot, audit };
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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    pool = createPool({ connectionString: appUrl, max: 4 });
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  }, 120_000);

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => {});
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('seeds the two presets as read-only data rows, starts every org on founder, and lets nobody call the guards', async () => {
    const o = await org();
    expect(await o.policy()).toEqual({ preset: 'founder', version: 1 });
    const { presets, writes, callers } = await withAdmin(async (c) => ({
      presets: (await c.query('SELECT key, ledger_chief_accountant_only AS chief FROM crove_kernel.approval_preset ORDER BY key')).rows,
      writes: (
        await c.query<{ role: string; op: string }>(
          `SELECT r AS role, p AS op FROM unnest($1::text[]) r, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
           WHERE has_table_privilege(r, 'crove_kernel.approval_preset', p) ORDER BY 1, 2`,
          [ROLES],
        )
      ).rows,
      callers: (
        await c.query<{ fn: string; role: string }>(
          `SELECT f AS fn, r AS role FROM unnest(ARRAY['crove_kernel.tenant_approval_policy_guard()', 'crove_kernel.tenant_approval_policy_requires_audit()']) f, unnest($1::text[]) r
           WHERE has_function_privilege(r, f::regprocedure, 'EXECUTE')`,
          [ROLES],
        )
      ).rows,
    }));
    expect(presets).toEqual([
      { key: 'accountant', chief: true },
      { key: 'founder', chief: false },
    ]);
    expect(writes).toEqual([]);
    expect(callers).toEqual([]);
  });

  it('lets only an owner switch the preset, with fresh MFA, audited, and never to accountant without a chief accountant', async () => {
    const o = await org();
    await expect(o.setPreset(asMfa(o.admin), 'accountant')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(o.setPreset(asMfa(o.chief), 'accountant')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(o.setPreset(asUser(o.owner), 'accountant')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(o.setPreset(asMfa(o.owner), 'auditor')).rejects.toMatchObject({ code: 'UNKNOWN_PRESET', status: 422 });
    // Liveness: nobody could approve the ledger's proposals under accountant.
    await expect(o.setPreset(asMfa(o.owner), 'accountant')).rejects.toMatchObject({ code: 'NO_CHIEF_ACCOUNTANT', status: 422 });
    expect(await o.policy()).toEqual({ preset: 'founder', version: 1 });

    await o.exec(asMfa(o.owner), 'kernel.member.role.assign', { userId: o.chief, roleKey: 'finance.chief_accountant', legalEntityId: null });
    await expect(o.setPreset(asMfa(o.owner), 'accountant')).resolves.toEqual({ preset: 'accountant', version: 2 });
    expect(await o.audit('kernel.org.set_approval_preset')).toMatchObject({ previous: 'founder', preset: 'accountant', version: 2 });
    // The same preset again changes nothing.
    await expect(o.setPreset(asMfa(o.owner), 'accountant')).resolves.toEqual({ preset: 'accountant', version: 2 });
    await expect(o.setPreset(asMfa(o.owner), 'founder')).resolves.toEqual({ preset: 'founder', version: 3 });
    expect(await o.policy()).toEqual({ preset: 'founder', version: 3 });
    // Every member reads it.
    await expect(rt.query('kernel.org.get', {}, { actor: asUser(o.chief), orgId: o.orgId })).resolves.toMatchObject({ approvalPreset: 'founder', approvalPolicyVersion: 3 });
  });

  it('refuses every other write of the preset or its version, in the database', async () => {
    const o = await org();
    await o.exec(asMfa(o.owner), 'kernel.member.role.assign', { userId: o.chief, roleKey: 'finance.chief_accountant', legalEntityId: null });
    const write = (userId: string, sql: string) => committedInContext(userId, o.orgId, async (c) => void (await c.query(sql, [o.orgId])));
    // An admin, a member, an owner that skips the version or keeps it, and an owner without the command's audit row.
    await expect(write(o.admin, "UPDATE crove_kernel.tenant SET approval_preset = 'accountant', approval_policy_version = 2 WHERE org_id = $1")).rejects.toMatchObject({
      message: 'APPROVAL_POLICY_FORBIDDEN',
    });
    await expect(write(o.chief, "UPDATE crove_kernel.tenant SET approval_preset = 'accountant', approval_policy_version = 2 WHERE org_id = $1")).rejects.toMatchObject({
      message: 'APPROVAL_POLICY_FORBIDDEN',
    });
    await expect(write(o.owner, "UPDATE crove_kernel.tenant SET approval_preset = 'accountant' WHERE org_id = $1")).rejects.toMatchObject({
      message: 'APPROVAL_POLICY_FORBIDDEN',
    });
    await expect(write(o.owner, 'UPDATE crove_kernel.tenant SET approval_policy_version = 5 WHERE org_id = $1')).rejects.toMatchObject({
      message: 'APPROVAL_POLICY_FORBIDDEN',
    });
    await expect(write(o.owner, "UPDATE crove_kernel.tenant SET approval_preset = 'accountant', approval_policy_version = 2 WHERE org_id = $1")).rejects.toMatchObject({
      message: 'APPROVAL_POLICY_UNAUDITED',
    });
    expect(await o.policy()).toEqual({ preset: 'founder', version: 1 });
  });

  it('under the accountant preset, lets only the chief accountant approve the ledger (P09), and records the policy it ran under', async () => {
    const o = await org();
    await o.exec(asMfa(o.owner), 'kernel.member.role.assign', { userId: o.chief, roleKey: 'finance.chief_accountant', legalEntityId: null });
    // Raised under founder: the owner and the admin are in its snapshot.
    const before = await o.proposal();
    expect(await o.snapshot(before)).toEqual([o.owner, o.admin, o.chief].sort());
    await o.setPreset(asMfa(o.owner), 'accountant');

    // A proposal raised now names only the chief accountant.
    const after = await o.proposal();
    expect(await o.snapshot(after)).toEqual([o.chief]);
    await expect(o.approve(asMfa(o.admin), after)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE', status: 403 });
    await expect(o.approve(asMfa(o.owner), after)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE', status: 403 });
    // The switch applies to the earlier proposal at once: its snapshot is filtered by the preset in force.
    await expect(o.approve(asMfa(o.admin), before)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE', status: 403 });
    await expect(o.approve(asMfa(o.owner), before)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE', status: 403 });
    await expect(o.approve(asMfa(o.chief), after)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
    expect(await o.audit('kernel.proposal.approve', after)).toMatchObject({
      policy: { P12: 'pass', P10: 'pass' },
      policy_version: 2,
      org_policy: { preset: 'accountant', version: 2 },
      build: 'dev',
      eligible_approvers: 1,
    });

    // Back on founder, the owner approves the earlier proposal again (it is in its snapshot), flagged with the version.
    await o.setPreset(asMfa(o.owner), 'founder');
    await expect(o.approve(asMfa(o.admin), before)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
    expect(await o.audit('kernel.proposal.approve', before)).toMatchObject({ org_policy: { preset: 'founder', version: 3 } });
  });

  it('under the accountant preset, never lets an author approve a ledger proposal, even as its only eligible approver (P10)', async () => {
    const o = await org();
    await o.exec(asMfa(o.owner), 'kernel.member.role.assign', { userId: o.chief, roleKey: 'finance.chief_accountant', legalEntityId: null });
    // Under founder the chief accountant's own proposal needs another approver (owner and admin are eligible).
    const own = await o.proposal(o.chief);
    await expect(o.approve(asMfa(o.chief), own)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    // Under accountant the chief accountant is the only eligible approver, of this pending proposal and of a new one,
    // and still never approves their own: no sole-approver exception.
    await o.setPreset(asMfa(o.owner), 'accountant');
    await expect(o.approve(asMfa(o.chief), own)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    const fresh = await o.proposal(o.chief);
    expect(await o.snapshot(fresh)).toEqual([o.chief]);
    await expect(o.approve(asMfa(o.chief), fresh)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });

    // An owner who makes themself chief accountant does not approve their own proposal either (no owner_override),
    // and another chief accountant does.
    await o.exec(asMfa(o.owner), 'kernel.member.role.assign', { userId: o.owner, roleKey: 'finance.chief_accountant', legalEntityId: null });
    const owners = await o.proposal(o.owner);
    expect(await o.snapshot(owners)).toEqual([o.owner, o.chief].sort());
    await expect(o.approve(asMfa(o.owner), owners)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    await expect(o.approve(asMfa(o.chief), owners)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
    expect(await o.audit('kernel.proposal.approve', owners)).toMatchObject({ policy: { P10: 'pass' }, self_approved: false });
    // The owner, now a holder, approves the chief accountant's proposal raised after the grant; the one raised before
    // (snapshot [chief]) waits, since an approver added later never joins a snapshot.
    const later = await o.proposal(o.chief);
    await expect(o.approve(asMfa(o.owner), later)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
    await expect(o.approve(asMfa(o.owner), fresh)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
  });

  it('keeps the last chief accountant while on the accountant preset: no revoke, removal or demotion to viewer', async () => {
    const o = await org();
    const { assignmentId } = await o.exec<{ assignmentId: string }>(asMfa(o.owner), 'kernel.member.role.assign', {
      userId: o.chief,
      roleKey: 'finance.chief_accountant',
      legalEntityId: null,
    });
    await o.setPreset(asMfa(o.owner), 'accountant');
    await expect(o.exec(asMfa(o.owner), 'kernel.member.role.revoke', { assignmentId })).rejects.toMatchObject({ code: 'LAST_CHIEF_ACCOUNTANT', status: 409 });
    await expect(o.exec(asMfa(o.owner), 'kernel.member.change_role', { userId: o.chief, role: 'viewer' })).rejects.toMatchObject({ code: 'LAST_CHIEF_ACCOUNTANT' });
    await expect(o.exec(asMfa(o.owner), 'kernel.member.remove', { userId: o.chief })).rejects.toMatchObject({ code: 'LAST_CHIEF_ACCOUNTANT' });
    expect(await withAdmin(async (c) => (await c.query('SELECT 1 FROM crove_kernel.role_assignment WHERE id = $1', [assignmentId])).rowCount)).toBe(1);
    // Other changes of that member, and changes once someone else holds the role, go through.
    await expect(o.exec(asMfa(o.owner), 'kernel.member.change_role', { userId: o.chief, role: 'admin' })).resolves.toMatchObject({ role: 'admin' });
    const second = await o.exec<{ assignmentId: string }>(asMfa(o.owner), 'kernel.member.role.assign', {
      userId: o.owner,
      roleKey: 'finance.chief_accountant',
      legalEntityId: null,
    });
    await expect(o.exec(asMfa(o.owner), 'kernel.member.remove', { userId: o.chief })).resolves.toMatchObject({ userId: o.chief });
    await expect(o.exec(asMfa(o.owner), 'kernel.member.role.revoke', { assignmentId: second.assignmentId })).rejects.toMatchObject({ code: 'LAST_CHIEF_ACCOUNTANT' });
    // Back on founder, the role is an ordinary one again.
    await o.setPreset(asMfa(o.owner), 'founder');
    await expect(o.exec(asMfa(o.owner), 'kernel.member.role.revoke', { assignmentId: second.assignmentId })).resolves.toMatchObject({ assignmentId: second.assignmentId });
  });

  // #1933: a change made without an idempotency key holds nothing on the org's tenant row before its keep guard runs.
  // The guard used to read the preset (founder) before it locked and return at once, so a switch to the accountant
  // preset still counted the holder whose revoke was not committed yet, and both committed. The revoke here runs in a
  // session left open, as the owner, without an idempotency row, while the owner's switch runs through the command.
  it('never ends on the accountant preset without a chief accountant when a revoke without an idempotency key races the switch (#1933)', async () => {
    const o = await org();
    const { assignmentId } = await o.exec<{ assignmentId: string }>(asMfa(o.owner), 'kernel.member.role.assign', {
      userId: o.chief,
      roleKey: 'finance.chief_accountant',
      legalEntityId: null,
    });
    const remover = await connect(appUrl);
    await remover.query('BEGIN');
    try {
      await remover.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(o.owner, o.orgId)]);
      // The last chief accountant's assignment is deleted, and not committed yet.
      await remover.query('SELECT * FROM crove_kernel.role_assignment_revoke($1::uuid)', [assignmentId]);
      let settled = false;
      const switching = o.setPreset(asMfa(o.owner), 'accountant').then(
        (value) => {
          settled = true;
          return value;
        },
        (error: { code?: string }) => {
          settled = true;
          return error.code;
        },
      );
      // The switch finishes (the old guard held nothing), or waits for the revoke's row lock on the tenant row (a wait on
      // the revoke's transaction or on the row itself, never a passing lock such as a relation extension).
      for (let tries = 0; !settled; tries++) {
        const { rows } = await withAdmin((c) =>
          c.query(
            `SELECT 1 FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
             WHERE NOT l.granted AND l.locktype IN ('transactionid', 'tuple') AND a.usename = 'crove_app'
               AND a.datname = pg_catalog.current_database()`,
          ),
        );
        if (rows.length > 0) break;
        if (tries > 400) throw new Error('the switch neither finished nor waited');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(settled).toBe(false);
      await remover.query('COMMIT');
      // Once the revoke committed, the switch counts no chief accountant.
      expect(await switching).toBe('NO_CHIEF_ACCOUNTANT');
    } finally {
      await remover.query('ROLLBACK').catch(() => {});
    }
    expect(await o.policy()).toEqual({ preset: 'founder', version: 1 });
    expect(await withAdmin(async (c) => (await c.query('SELECT 1 FROM crove_kernel.role_assignment WHERE id = $1', [assignmentId])).rowCount)).toBe(0);
  });

  it('refuses the switch to an AI agent', async () => {
    const o = await org();
    await o.exec(asMfa(o.owner), 'kernel.member.role.assign', { userId: o.chief, roleKey: 'finance.chief_accountant', legalEntityId: null });
    const { agentId, positionId } = await o.exec<{ agentId: string; positionId: string }>(asMfa(o.owner), 'kernel.agent.template.install', {
      templateKey: 'finance.chief_accountant',
      reportsTo: null,
    });
    await o.exec(asUser(o.owner), 'kernel.task.create', { title: 'Việc thử', assigneePositionId: positionId });
    const started = await worker.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId },
      { actor: { type: 'system', component: 'kernel.agent' }, orgId: o.orgId },
    );
    const agent: AgentActor = { type: 'agent', agentId, runId: started.runId as string };
    await expect(
      worker.execute('kernel.org.set_approval_preset', { preset: 'accountant' }, { actor: agent, orgId: o.orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(await o.policy()).toEqual({ preset: 'founder', version: 1 });
  });
});
