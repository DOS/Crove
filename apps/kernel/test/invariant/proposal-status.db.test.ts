// The proposal status guard (#1707, from the review of #1695; plan §4.10) on PostgreSQL 17, as the real login roles: a
// proposal moves pending -> approved -> executed, or pending -> rejected or expired, and nothing else. Every other change
// of status, out of a terminal state, back from 'approved' or 'pending' straight to 'executed', is refused for every
// tenant writer (owner, member and viewer contexts on crove_app, the system context on crove_worker); an agent context
// writes no proposal at all. A decided proposal's decision, and a terminal one's content and result, stay as they were,
// and it cannot be rebuilt: no insert of an approved or executed proposal, no delete of a decided one, no new id.
// Since #1816 approved -> executed needs the ok audit row of the proposal's own command, naming it, written in the
// same transaction by the same writer (the runtime writes it when the command ran), so a plain update is refused.
// Staff (the database owner) are not checked. Approval, rejection and expiry through the runtime still pass. Part of the
// invariant suite: keep it self-contained (package code under test, no helpers from outside test/invariant/). Set
// CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
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
const TEMPLATE = 'finance.chief_accountant';
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const STATUSES = ['pending', 'approved', 'executed', 'rejected', 'failed', 'expired'] as const;
type Status = (typeof STATUSES)[number];
// The transitions the runtime makes; every other change of status is refused.
const ALLOWED = new Set(['pending>approved', 'pending>rejected', 'pending>expired', 'approved>executed']);
// Since #1793 only the system context moves a proposal to approved by an update (the worker executing an agent's
// approval); a user's context goes through the gate (crove_kernel.proposal_approve, proposal-approve-gate.db.test.ts).
const SYSTEM_ONLY = new Set(['pending>approved']);
// Since #1816 approved -> executed needs the ok row of the proposal's command, written in the same transaction by the
// same writer: a plain update is refused (the next tests write that row first).
const NEEDS_RUN = new Set(['approved>executed']);
const REFUSED = { code: '23514', message: 'PROPOSAL_STATUS_TRANSITION' };
const suite = ADMIN ? describe : describe.skip;

suite('proposal status transitions on PostgreSQL (#1707)', () => {
  const dbName = `crove_test_proposal_status_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let owner = '';
  let member = '';
  let viewer = '';
  let orgId = '';
  let agent: AgentActor;

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

  // A writer: a login role and the context it enters. Every statement runs in its own transaction, rolled back.
  interface Writer {
    name: string;
    url: () => string;
    enter: (c: pg.Client) => Promise<unknown>;
  }
  const writers = (): Writer[] => [
    { name: 'owner', url: () => appUrl, enter: (c) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(owner, orgId)]) },
    { name: 'member', url: () => appUrl, enter: (c) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(member, orgId)]) },
    { name: 'viewer', url: () => appUrl, enter: (c) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(viewer, orgId)]) },
    { name: 'system', url: () => workerUrl, enter: (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]) },
  ];

  async function as<T>(writer: Writer, fn: (c: pg.Client) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string | undefined; message: string }> {
    const c = new pg.Client({ connectionString: writer.url() });
    await c.connect();
    try {
      await c.query('BEGIN');
      await writer.enter(c);
      return { ok: true, value: await fn(c) };
    } catch (error) {
      const e = error as { code?: string; message: string };
      return { ok: false, code: e.code, message: e.message };
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  // A proposal in the given status, written by the database owner (staff are not checked), with a decision when it has
  // one.
  async function proposal(status: Status): Promise<string> {
    const decided = status !== 'pending';
    return admin(async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.proposal (org_id, kind, command, status, title, payload, eligible_approvers, authors,
                                              decided_by, decided_at, executed_command_id, result)
           VALUES ($1, 't1707', 't1707.prop', $2, 'T1707', '{"n": 1}', ARRAY[$3::uuid], '[]', $4, $5, $6, $7) RETURNING id`,
          [
            orgId,
            status,
            owner,
            decided ? owner : null,
            decided ? new Date() : null,
            status === 'approved' || status === 'executed' ? randomUUID() : null,
            status === 'executed' ? JSON.stringify({ ok: true }) : null,
          ],
        )
      ).rows[0]?.id as string,
    );
  }

  // The move a writer would make: from 'pending' with the decision the runtime writes, from anything else the status
  // alone (a decided proposal's decision is frozen).
  const move = (from: Status, to: Status) =>
    from === 'pending'
      ? `UPDATE crove_kernel.proposal SET status = '${to}', decided_by = $2, decided_at = now(), executed_command_id = gen_random_uuid() WHERE org_id = $3 AND id = $1`
      : `UPDATE crove_kernel.proposal SET status = '${to}' WHERE org_id = $3 AND id = $1 AND $2::uuid IS NOT NULL`;

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
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    };
    app = runtimeFor(appUrl);
    worker = runtimeFor(workerUrl);
    const db = createDb(pools[0] as pg.Pool);
    const person = (name: string) => upsertIdentity(db, { issuer: 't1707', subject: randomUUID(), email: `${name}@t1707.test`, name: null });
    owner = await person('owner');
    member = await person('member');
    viewer = await person('viewer');
    ({ orgId } = await createOrg(app, asUser(owner), 'T1707'));
    await admin(async (c) => {
      for (const [user, role] of [
        [member, 'member'],
        [viewer, 'viewer'],
      ] as const) {
        await c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, user, role]);
      }
    });
    // An agent with a live run, for the agent context.
    const { agentId, positionId } = await app.execute<{ agentId: string; positionId: string }>('kernel.agent.template.install', { templateKey: TEMPLATE }, { actor: asMfa(owner), orgId });
    await app.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId }, { actor: SYSTEM, orgId });
    if (!started.runId) throw new Error('no run');
    agent = { type: 'agent', agentId, runId: started.runId };
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets every tenant writer make only the runtime transitions, and refuses every other change of status', async () => {
    const rows = Object.fromEntries(await Promise.all(STATUSES.map(async (s) => [s, await proposal(s)] as const))) as Record<Status, string>;
    for (const writer of writers()) {
      for (const from of STATUSES) {
        for (const to of STATUSES.filter((s) => s !== from)) {
          const outcome = await as(writer, (c) => c.query(move(from, to), [rows[from], owner, orgId]));
          const where = `${writer.name}: ${from} -> ${to}`;
          if (ALLOWED.has(`${from}>${to}`) && !NEEDS_RUN.has(`${from}>${to}`) && (writer.name === 'system' || !SYSTEM_ONLY.has(`${from}>${to}`))) {
            expect(outcome, where).toMatchObject({ ok: true });
            expect(outcome.ok && outcome.value.rowCount, where).toBe(1);
          } else {
            expect(outcome, where).toMatchObject({ ok: false, ...REFUSED });
          }
        }
      }
    }
    // Nothing committed: every proposal keeps its status.
    const kept = await admin(async (c) =>
      Object.fromEntries((await c.query<{ id: string; status: string }>('SELECT id, status FROM crove_kernel.proposal WHERE id = ANY($1::uuid[])', [Object.values(rows)])).rows.map((r) => [r.id, r.status])),
    );
    expect(kept).toEqual(Object.fromEntries(STATUSES.map((s) => [rows[s], s])));
  });

  it('refuses an approval that names no executing command, a changed decision and a changed terminal outcome', async () => {
    const pending = await proposal('pending');
    const approved = await proposal('approved');
    const executed = await proposal('executed');
    const rejected = await proposal('rejected');
    for (const writer of writers()) {
      const cases: Array<[string, unknown[]]> = [
        [`UPDATE crove_kernel.proposal SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`, [pending, owner]],
        [`UPDATE crove_kernel.proposal SET decided_by = $2 WHERE id = $1`, [approved, member]],
        [`UPDATE crove_kernel.proposal SET executed_command_id = gen_random_uuid() WHERE id = $1 AND $2::uuid IS NOT NULL`, [approved, owner]],
        [`UPDATE crove_kernel.proposal SET decided_by = $2, decided_at = now() WHERE id = $1`, [rejected, member]],
        [`UPDATE crove_kernel.proposal SET result = '{"forged": true}' WHERE id = $1 AND $2::uuid IS NOT NULL`, [executed, owner]],
        [`UPDATE crove_kernel.proposal SET payload = '{"n": 2}', revision = revision + 1 WHERE id = $1 AND $2::uuid IS NOT NULL`, [executed, owner]],
        [`UPDATE crove_kernel.proposal SET decision_note = 'sửa' WHERE id = $1 AND $2::uuid IS NOT NULL`, [rejected, owner]],
      ];
      for (const [text, values] of cases) {
        await expect(as(writer, (c) => c.query(text, values)), `${writer.name}: ${text}`).resolves.toMatchObject({ ok: false, ...REFUSED });
      }
      // A terminal proposal changes in no column at all: its authors and eligible approvers are the P10 and P12
      // evidence, and nothing else of it moves either.
      for (const [column, value] of [
        ['authors', `'[{"type": "user", "id": "${member}"}]'`],
        ['eligible_approvers', `ARRAY['${member}'::uuid]`],
        ['title', "'Sửa'"],
        ['command', "'t1707.other'"],
        ['reminded_at', 'now()'],
      ] as const) {
        for (const id of [executed, rejected]) {
          await expect(as(writer, (c) => c.query(`UPDATE crove_kernel.proposal SET ${column} = ${value} WHERE id = $1`, [id])), `${writer.name}: ${column}`).resolves.toMatchObject({
            ok: false,
            ...REFUSED,
          });
        }
      }
      // An update that writes the same values passes (the RLS matrix's own-row control does that).
      const same = await as(writer, (c) => c.query('UPDATE crove_kernel.proposal SET title = title, authors = authors WHERE id = $1', [executed]));
      expect(same.ok && same.value.rowCount, `${writer.name}: same values`).toBe(1);
      // A pending proposal's other columns stay writable, as the reminders write them.
      const reminded = await as(writer, (c) => c.query('UPDATE crove_kernel.proposal SET reminded_at = now() WHERE id = $1', [pending]));
      expect(reminded, `${writer.name}: reminded_at`).toMatchObject({ ok: true });
    }
  });

  it('moves an approved proposal to executed only after the ok row of its command, by the same writer in the same transaction (#1816)', async () => {
    // The row the runtime writes when a command ran with the proposal's id; audit_event_stamp sets its actor and time.
    const ran = (command: string, outcome: string, proposalId: string) => (c: pg.Client) =>
      c.query(
        `INSERT INTO crove_kernel.audit_event (org_id, actor_type, command, command_id, outcome, input_sha256, proposal_id)
         VALUES ($1, 'user', $2, gen_random_uuid(), $3, repeat('0', 64), $4)`,
        [orgId, command, outcome, proposalId],
      );
    const execute = (id: string) => (c: pg.Client) => c.query(`UPDATE crove_kernel.proposal SET status = 'executed', result = '{"ok": true}' WHERE org_id = $1 AND id = $2`, [orgId, id]);
    for (const writer of writers()) {
      const approved = await proposal('approved');
      const other = await proposal('approved');
      // The command's own ok row, naming it, in this transaction: the move passes.
      const done = await as(writer, async (c) => {
        await ran('t1707.prop', 'ok', approved)(c);
        return execute(approved)(c);
      });
      expect(done.ok && done.value.rowCount, `${writer.name}: after its run`).toBe(1);
      // Another command's row, a failed run, or a run naming another proposal: refused.
      for (const [label, row] of [
        ['another command', ran('t1707.other', 'ok', approved)],
        ['a failed run', ran('t1707.prop', 'failed', approved)],
        ['another proposal', ran('t1707.prop', 'ok', other)],
      ] as const) {
        const outcome = await as(writer, async (c) => {
          await row(c);
          return execute(approved)(c);
        });
        expect(outcome, `${writer.name}: after ${label}`).toMatchObject({ ok: false, ...REFUSED });
      }
    }
    // A row committed by an earlier transaction does not carry a later move, and another writer's row in the same
    // transaction cannot be had (the stamp writes the context's actor), so the earlier one is the case to check.
    const approved = await proposal('approved');
    const [ownerWriter, memberWriter] = writers() as [Writer, Writer];
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await ownerWriter.enter(c);
      await ran('t1707.prop', 'ok', approved)(c);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    for (const writer of [ownerWriter, memberWriter]) {
      await expect(as(writer, execute(approved)), `${writer.name}: after an earlier transaction's run`).resolves.toMatchObject({ ok: false, ...REFUSED });
    }
    // A row undone with its savepoint is no row (#1840): the move after the rollback is refused.
    for (const writer of writers()) {
      const undone = await as(writer, async (c) => {
        await c.query('SAVEPOINT ran');
        await ran('t1707.prop', 'ok', approved)(c);
        await c.query('ROLLBACK TO SAVEPOINT ran');
        return execute(approved)(c);
      });
      expect(undone, `${writer.name}: after a rolled-back run`).toMatchObject({ ok: false, ...REFUSED });
    }
    // One statement that writes the row first is two statements in one (#1840): the update reads the CTE, so its insert
    // runs first, and proposal_status_guard is VOLATILE, so its expression takes a fresh snapshot (after a command
    // counter increment) that the STABLE proposal_execution_recorded reads. The ok row passes, a failed one is refused.
    // Dropping the EXISTS or marking the guard STABLE flips the first case.
    const inOneStatement = (outcome: string) => (c: pg.Client) =>
      c.query(
        `WITH r AS (
           INSERT INTO crove_kernel.audit_event (org_id, actor_type, command, command_id, outcome, input_sha256, proposal_id)
           VALUES ($1, 'user', 't1707.prop', gen_random_uuid(), $2, repeat('0', 64), $3) RETURNING id)
         UPDATE crove_kernel.proposal SET status = 'executed', result = '{"ok": true}' WHERE org_id = $1 AND id = $3 AND EXISTS (SELECT 1 FROM r)`,
        [orgId, outcome, approved],
      );
    for (const writer of writers()) {
      await expect(as(writer, inOneStatement('ok')), `${writer.name}: one statement, ok row`).resolves.toMatchObject({ ok: true, value: { rowCount: 1 } });
      await expect(as(writer, inOneStatement('failed')), `${writer.name}: one statement, failed row`).resolves.toMatchObject({ ok: false, ...REFUSED });
    }
    // The check answers for the org of the context only: the same row, asked about from another org, is not there.
    for (const writer of writers()) {
      const answer = await as(writer, async (c) => {
        await ran('t1707.prop', 'ok', approved)(c);
        const asked = (org: string) =>
          c.query<{ recorded: boolean }>('SELECT crove_kernel.proposal_execution_recorded($1::uuid, $2::uuid, $3) AS recorded', [org, approved, 't1707.prop']);
        return { own: (await asked(orgId)).rows[0]?.recorded, other: (await asked(randomUUID())).rows[0]?.recorded };
      });
      expect(answer, `${writer.name}: asked for its org and another`).toMatchObject({ ok: true, value: { own: true, other: false } });
    }
  });

  it('keeps a decided proposal from being rebuilt: no insert of an approved or executed one, no delete of a decided one, no new id', async () => {
    const insert = (status: Status, command: string | null) =>
      `INSERT INTO crove_kernel.proposal (org_id, kind, command, status, title, payload, eligible_approvers, authors, executed_command_id)
       VALUES ($1, 't1707', 't1707.prop', '${status}', 'T1707', '{}', ARRAY[$2::uuid], '[]', ${command === null ? 'NULL' : `'${command}'::uuid`})`;
    for (const writer of writers()) {
      for (const status of ['approved', 'executed'] as const) {
        await expect(as(writer, (c) => c.query(insert(status, randomUUID()), [orgId, owner])), `${writer.name}: insert ${status}`).resolves.toMatchObject({ ok: false, ...REFUSED });
      }
      await expect(as(writer, (c) => c.query(insert('pending', randomUUID()), [orgId, owner])), `${writer.name}: insert naming a command`).resolves.toMatchObject({
        ok: false,
        ...REFUSED,
      });
      // Nor one that names who or when decided it.
      for (const decision of ['decided_by = $2', 'decided_at = now()']) {
        const column = decision.split(' = ')[0] as string;
        const value = decision.split(' = ')[1] as string;
        const sql = `INSERT INTO crove_kernel.proposal (org_id, kind, command, status, title, payload, eligible_approvers, authors, ${column})
                     VALUES ($1, 't1707', 't1707.prop', 'rejected', 'T1707', '{}', ARRAY[$2::uuid], '[]', ${value})`;
        await expect(as(writer, (c) => c.query(sql, [orgId, owner])), `${writer.name}: insert naming ${column}`).resolves.toMatchObject({ ok: false, ...REFUSED });
      }
      // A pending one, as the runtime writes it, and a decided one that names no command (it decides nothing).
      // A pending one only from the system context: a user's names itself among the authors (#1793), this one does not.
      for (const status of ['pending', 'rejected'] as const) {
        const inserted = await as(writer, (c) => c.query(insert(status, null), [orgId, owner]));
        if (writer.name !== 'system' && status === 'pending') expect(inserted, `${writer.name}: insert ${status}`).toMatchObject({ ok: false, ...REFUSED });
        else expect(inserted, `${writer.name}: insert ${status}`).toMatchObject({ ok: true });
      }
      for (const status of STATUSES.filter((s) => s !== 'pending')) {
        const id = await proposal(status);
        await expect(as(writer, (c) => c.query('DELETE FROM crove_kernel.proposal WHERE id = $1', [id])), `${writer.name}: delete ${status}`).resolves.toMatchObject({
          ok: false,
          ...REFUSED,
        });
        await expect(as(writer, (c) => c.query('UPDATE crove_kernel.proposal SET id = gen_random_uuid() WHERE id = $1', [id])), `${writer.name}: new id ${status}`).resolves.toMatchObject({
          ok: false,
          ...REFUSED,
        });
      }
      const pending = await proposal('pending');
      const deleted = await as(writer, (c) => c.query('DELETE FROM crove_kernel.proposal WHERE id = $1', [pending]));
      expect(deleted.ok && deleted.value.rowCount, `${writer.name}: delete pending`).toBe(1);
    }
  });

  it('keeps an agent context from writing any proposal, and leaves staff unchecked', async () => {
    const pending = await proposal('pending');
    const c = new pg.Client({ connectionString: workerUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agent.agentId, agent.runId]);
      await expect(
        c.query(`UPDATE crove_kernel.proposal SET status = 'approved', decided_by_agent = $2, decided_at = now(), executed_command_id = gen_random_uuid() WHERE id = $1`, [
          pending,
          agent.agentId,
        ]),
      ).rejects.toMatchObject({ code: '42501', message: 'AGENT_FORBIDDEN' });
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
    // The database owner may correct history (a support fix, a test that builds it).
    const executed = await proposal('executed');
    await admin((a) => a.query(`UPDATE crove_kernel.proposal SET status = 'pending', decided_by = NULL, decided_at = NULL WHERE id = $1`, [executed]));
    expect((await admin((a) => a.query<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE id = $1', [executed]))).rows[0]?.status).toBe('pending');
  });

  it('still lets the runtime approve, reject and expire', async () => {
    const voucher = {
      command: 'finance.journal_voucher.record',
      input: {
        date: '2026-10-05',
        description: 'Trích trước tiền điện',
        lines: [
          { account: '6422', debit: '450000', credit: '0' },
          { account: '3388', debit: '0', credit: '450000' },
        ],
      },
    };
    const ask = async () =>
      (await app.execute<{ proposalId: string }>('kernel.proposal.request', voucher, { actor: asUser(owner), orgId, idempotencyKey: randomUUID() })).proposalId;
    const statusOf = async (id: string) => (await admin((a) => a.query<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE id = $1', [id]))).rows[0]?.status;

    // Approved and executed in one transaction (the owner is the only eligible approver, so it may approve its own).
    const approved = await ask();
    const detail = await app.query<{ revision: number }>('kernel.inbox.get', { id: approved }, { actor: asUser(owner), orgId });
    await app.execute('kernel.proposal.approve', { id: approved, revision: detail.revision }, { actor: asMfa(owner), orgId });
    expect(await statusOf(approved)).toBe('executed');
    // Once executed, it is not decided again through the runtime either.
    await expect(app.execute('kernel.proposal.reject', { id: approved }, { actor: asUser(owner), orgId })).rejects.toMatchObject({ status: 409 });

    const rejected = await ask();
    await app.execute('kernel.proposal.reject', { id: rejected, reason: 'không cần' }, { actor: asUser(owner), orgId });
    expect(await statusOf(rejected)).toBe('rejected');

    // Expiry is the system's: the move it makes (pending -> expired, with its time) passes in its context.
    const expiring = await ask();
    const expired = await as(writers()[3] as Writer, (c) => c.query(`UPDATE crove_kernel.proposal SET status = 'expired', decided_at = now() WHERE id = $1`, [expiring]));
    expect(expired).toMatchObject({ ok: true });
  });
});
