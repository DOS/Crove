// Open tasks a chart or role change would strand go up the chart (#1799) on PostgreSQL, as the real login roles. A task
// of a legal entity is listed by its position's holder only while that holder reads the entity (#1762, #1788). When a
// change takes that away (another holder, a narrower seat scope, a person's first entity assignment, a demotion, an
// owner's own), the
// command moves each such open task to the entity-aware escalation target of #1788, else to the owners, with an
// activity row that takes the task's entity, an event the notification dispatch turns into a notice for whoever has it
// now, and the moves in the command's audit row. Org-level tasks and tasks the holder still reads stay. The database
// moves them set-based (crove_kernel.task_reroute), for an owner's context only.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';
import { enterUser } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'kernel.notification' };
const suite = ADMIN ? describe : describe.skip;

suite('tasks a chart or role change would strand (#1799)', () => {
  const dbName = `crove_test_task_reroute_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let owner = '';
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

  // A member of the org, with the given role and, if any, an assignment limited to an entity.
  async function member(name: string, role: 'admin' | 'member', entity: string | null) {
    const db = createDb(pools[0] as pg.Pool);
    const user = await upsertIdentity(db, { issuer: 't1799', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@t1799.test`, name: null });
    await admin(async (c) => {
      await c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, user, role]);
      if (entity) {
        await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
          orgId,
          user,
          entity,
          owner,
        ]);
      }
    });
    return user;
  }

  async function seat(title: string, holder: string, reportsTo: string | null) {
    const { positionId } = await app.execute<{ positionId: string }>(
      'kernel.position.create',
      { title, module: 'finance', roleKey: 'finance.accountant', reportsTo },
      { actor: asMfa(owner), orgId },
    );
    await app.execute('kernel.position.assign', { id: positionId, holder: { type: 'user', userId: holder } }, { actor: asMfa(owner), orgId });
    return positionId;
  }

  // A task about the entity (NULL: org-level) for the position, in the given status.
  const task = (entity: string | null, positionId: string, status = 'todo') =>
    admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.task (org_id, title, assignee_position_id, source, source_ref, created_by_type, status)
             VALUES ($1, 'Việc cần làm', $2, 'human', $3, 'user', $4) RETURNING id`,
            [orgId, positionId, entity ? JSON.stringify({ type: 'kernel.legal_entity', id: entity }) : null, status],
          )
        ).rows[0]?.id as string,
    );

  const appUrl = () => {
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    return url.toString();
  };

  // Polls until a lock is awaited: by the given backend (on the given table, or on a row, if said), or the advisory lock
  // of the given key (as pg_advisory_xact_lock(hashtextextended(key, 0)) takes it) by a backend of this database.
  async function untilWaiting(what: string, where: { pid: number; table?: string; row?: true } | { advisory: string }) {
    for (let tries = 0; ; tries++) {
      const { rows } = await admin((c) =>
        'advisory' in where
          ? c.query(
              `SELECT 1 FROM pg_catalog.pg_locks l, (SELECT pg_catalog.hashtextextended($1, 0) AS v) k
               WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
                 AND l.classid = ((k.v >> 32) & 4294967295)::oid AND l.objid = (k.v & 4294967295)::oid
                 AND l.database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())`,
              [where.advisory],
            )
          : c.query(
              `SELECT 1 FROM pg_catalog.pg_locks WHERE pid = $1 AND NOT granted
                 AND ($2::regclass IS NULL OR (locktype = 'relation' AND relation = $2::regclass))
                 AND (NOT $3 OR locktype IN ('transactionid', 'tuple'))`,
              [where.pid, where.table ?? null, where.row ?? false],
            ),
      );
      if (rows.length > 0) return;
      if (tries > 400) throw new Error(`${what} never waited`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const taskRow = (id: string) =>
    admin(
      async (c) =>
        (await c.query<{ assignee: string | null; status: string }>('SELECT assignee_position_id AS assignee, status FROM crove_kernel.task WHERE id = $1', [id])).rows[0],
    );

  // The rows a move leaves: its activity row (with the entity it took), its event, and the notice the dispatch writes.
  async function trail(taskId: string) {
    const { activity, events } = await admin(async (c) => ({
      activity: (
        await c.query<{ kind: string; entity: string | null }>(
          `SELECT kind, legal_entity_id AS entity FROM crove_kernel.activity WHERE record_type = 'kernel.task' AND record_id = $1`,
          [taskId],
        )
      ).rows,
      events: (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.outbox_event WHERE type = 'kernel.task.rerouted' AND payload -> 'taskIds' ? $1`, [taskId])).rows,
    }));
    for (const e of events) await worker.execute('kernel.notification.dispatch', { eventId: e.id }, { actor: SYSTEM, orgId });
    const notified = await admin(
      async (c) =>
        (await c.query<{ user_id: string }>(`SELECT user_id FROM crove_kernel.notification WHERE kind = 'kernel.task_rerouted' AND subject_id = $1 ORDER BY user_id`, [taskId])).rows.map(
          (r) => r.user_id,
        ),
    );
    return { activity, events: events.length, notified };
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
      return new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    };
    app = runtimeFor('crove_app', 'test-app-pw');
    worker = runtimeFor('crove_worker', 'test-worker-pw');
    owner = await upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 't1799', subject: randomUUID(), email: 'owner@t1799.test', name: null });
    ({ orgId } = await createOrg(app, asUser(owner), 'T1799'));
    await admin(async (c) => {
      defaultEntity = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      branch = (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner])
      ).rows[0]?.id as string;
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

  it('moves the tasks a new holder cannot read up the chart, and leaves the rest', async () => {
    const lead = await member('lead', 'member', null);
    const before = await member('before', 'member', null);
    const after = await member('after', 'member', branch);
    const leadSeat = await seat('Trưởng phòng', lead, null);
    const clerkSeat = await seat('Kế toán', before, leadSeat);
    const ofDefault = await task(defaultEntity, clerkSeat, 'in_progress');
    const ofBranch = await task(branch, clerkSeat);
    const orgLevel = await task(null, clerkSeat);
    const done = await task(defaultEntity, clerkSeat, 'done');

    await app.execute('kernel.position.assign', { id: clerkSeat, holder: { type: 'user', userId: after } }, { actor: asMfa(owner), orgId });

    // The default entity's open task goes to the lead, who reads it, and starts again as todo.
    expect(await taskRow(ofDefault)).toEqual({ assignee: leadSeat, status: 'todo' });
    // What the new holder reads, the org-level task and a closed task stay.
    expect(await taskRow(ofBranch)).toEqual({ assignee: clerkSeat, status: 'todo' });
    expect(await taskRow(orgLevel)).toEqual({ assignee: clerkSeat, status: 'todo' });
    expect(await taskRow(done)).toEqual({ assignee: clerkSeat, status: 'done' });
    expect(await trail(ofDefault)).toEqual({ activity: [{ kind: 'task.rerouted', entity: defaultEntity }], events: 1, notified: [lead] });
    expect((await trail(ofBranch)).events).toBe(0);
    // The command's audit row names the move.
    const audit = await admin(
      async (c) =>
        (
          await c.query<{ detail: { rerouted?: unknown } }>(
            `SELECT detail FROM crove_kernel.audit_event WHERE command = 'kernel.position.assign' AND target_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
            [clerkSeat],
          )
        ).rows[0]?.detail,
    );
    expect(audit?.rerouted).toEqual({ tasks: 1, to: [{ position: leadSeat, entity: defaultEntity, tasks: 1 }] });
    // It is among the lead's own tasks now.
    const mine = await app.query<{ tasks: Array<{ id: string }> }>('kernel.task.list', { mine: true }, { actor: asUser(lead), orgId });
    expect(mine.tasks.map((t) => t.id)).toContain(ofDefault);
    // The notice names the task by its title as it reads when shown, and keeps no copy of it (#1977): a title the
    // personal-data erasure redacts reads redacted in the notice too.
    const notice = async () =>
      (await app.query<{ items: Array<{ subjectId: string | null; detail: Record<string, string> }> }>('kernel.notification.list', {}, { actor: asUser(lead), orgId })).items.find(
        (i) => i.subjectId === ofDefault,
      );
    const titleOf = async () => (await admin((c) => c.query<{ title: string }>('SELECT title FROM crove_kernel.task WHERE id = $1', [ofDefault]))).rows[0]?.title;
    expect((await notice())?.detail).toEqual({ title: await titleOf() });
    const stored = await admin((c) => c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.notification WHERE kind = 'kernel.task_rerouted' AND subject_id = $1`, [ofDefault]));
    expect(stored.rows).toEqual([{ detail: {} }]);
    await admin((c) => c.query(`UPDATE crove_kernel.task SET title = 'Việc đã ẩn' WHERE id = $1`, [ofDefault]));
    expect((await notice())?.detail).toEqual({ title: 'Việc đã ẩn' });
    // Its activity row takes the task's entity: a member limited to the branch does not read it.
    const seen = async (user: string) => {
      const c = new pg.Client({ connectionString: appUrl() });
      await c.connect();
      try {
        await c.query('BEGIN');
        await enterUser(c, user, orgId);
        return (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.activity WHERE record_type = 'kernel.task' AND record_id = $1`, [ofDefault])).rows[0]?.n;
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    };
    expect(await seen(lead)).toBe(1);
    expect(await seen(after)).toBe(0);
  });

  it("moves a seat's tasks to the owners when its holder's first entity assignment leaves them out and nobody above reads them", async () => {
    const holder = await member('holder', 'member', null);
    const own = await seat('Kế toán chi nhánh', holder, null);
    const ofBranch = await task(branch, own);
    const ofDefault = await task(defaultEntity, own);

    await app.execute('kernel.member.role.assign', { userId: holder, roleKey: 'external_accountant', legalEntityId: defaultEntity }, { actor: asMfa(owner), orgId });

    expect(await taskRow(ofBranch)).toEqual({ assignee: null, status: 'todo' });
    expect(await taskRow(ofDefault)).toEqual({ assignee: own, status: 'todo' });
    // The owner acted, so the owner is not told about their own move; the activity row and the event are there.
    expect(await trail(ofBranch)).toEqual({ activity: [{ kind: 'task.rerouted', entity: branch }], events: 1, notified: [] });
  });

  it('moves them when the org-wide assignment is revoked and an entity one stays', async () => {
    const holder = await member('revoked', 'member', defaultEntity);
    const wide = await admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'finance.accountant', NULL, $3) RETURNING id`,
            [orgId, holder, owner],
          )
        ).rows[0]?.id as string,
    );
    const own = await seat('Kế toán tổng hợp', holder, null);
    const ofBranch = await task(branch, own);
    const ofDefault = await task(defaultEntity, own);

    await app.execute('kernel.member.role.revoke', { assignmentId: wide }, { actor: asMfa(owner), orgId });

    expect(await taskRow(ofBranch)).toEqual({ assignee: null, status: 'todo' });
    expect(await taskRow(ofDefault)).toEqual({ assignee: own, status: 'todo' });
  });

  it("moves an agent seat's tasks outside a narrower scope, ending the agent's lease on them", async () => {
    const { agentId, positionId } = await app.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', leScope: [defaultEntity, branch], reportsTo: null },
      { actor: asMfa(owner), orgId },
    );
    // A run starts on a wake-up, which giving the seat a task requests.
    await app.execute('kernel.task.create', { title: 'Việc chung', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
    const ofBranch = await task(branch, positionId);
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId }, { actor: { type: 'system', component: 'kernel.agent' }, orgId });
    if (!started.runId) throw new Error('no run');
    await worker.execute('kernel.task.checkout', { id: ofBranch }, { actor: { type: 'agent', agentId, runId: started.runId }, orgId });
    expect(await taskRow(ofBranch)).toEqual({ assignee: positionId, status: 'in_progress' });

    await app.execute('kernel.position.update', { id: positionId, leScope: [defaultEntity] }, { actor: asMfa(owner), orgId });

    expect(await taskRow(ofBranch)).toEqual({ assignee: null, status: 'todo' });
    const lease = await admin(
      async (c) => (await c.query<{ run: string | null }>('SELECT checkout_run_id AS run FROM crove_kernel.task WHERE id = $1', [ofBranch])).rows[0]?.run,
    );
    expect(lease).toBeNull();
  });

  it("moves what a removed member's vacant seat does not read, as #1788 reads a vacant seat (its le_scope)", async () => {
    const leaving = await member('leaving', 'member', null);
    const own = await seat('Thủ quỹ', leaving, null);
    const scope = await admin(
      async (c) => (await c.query<{ le_scope: string[] }>('SELECT le_scope FROM crove_kernel.position WHERE id = $1', [own])).rows[0]?.le_scope ?? [],
    );
    const ofBranch = await task(branch, own);

    await app.execute('kernel.member.remove', { userId: leaving }, { actor: asMfa(owner), orgId });

    // A vacant seat keeps the tasks its scope names, for an agent placed there later; the rest go up.
    const reads = scope.includes('*') || scope.includes(branch);
    expect(await taskRow(ofBranch)).toEqual({ assignee: reads ? own : null, status: 'todo' });
  });

  it('moves them when an admin limited to an entity is made a member', async () => {
    const limited = await member('limited-admin', 'admin', branch);
    const own = await seat('Kế toán trưởng', limited, null);
    const ofDefault = await task(defaultEntity, own, 'waiting');

    await app.execute('kernel.member.change_role', { userId: limited, role: 'member' }, { actor: asMfa(owner), orgId });

    expect(await taskRow(ofDefault)).toEqual({ assignee: null, status: 'waiting' });
  });

  it('moves them when an owner demotes themself while another owner stays', async () => {
    const coOwner = await member('co-owner', 'admin', defaultEntity);
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'owner' WHERE org_id = $1 AND user_id = $2`, [orgId, coOwner]));
    const own = await seat('Phó giám đốc', coOwner, null);
    const ofBranch = await task(branch, own);

    await app.execute('kernel.member.change_role', { userId: coOwner, role: 'member' }, { actor: asMfa(coOwner), orgId });

    expect(await taskRow(ofBranch)).toEqual({ assignee: null, status: 'todo' });
    // The other owner is told; the one who acted is not.
    expect((await trail(ofBranch)).notified).toEqual([owner]);
  });

  it('moves thousands of tasks in two statements, with one event and one notice for their new holder', async () => {
    const lead = await member('batch-lead', 'member', null);
    const holder = await member('batch-holder', 'member', null);
    const leadSeat = await seat('Trưởng nhóm', lead, null);
    const own = await seat('Nhân viên', holder, leadSeat);
    const many = 2000;
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.task (org_id, title, assignee_position_id, source, source_ref, created_by_type)
         SELECT $1, 'Việc ' || g, $2, 'human', $3, 'user' FROM generate_series(1, $4::int) g`,
        [orgId, own, JSON.stringify({ type: 'kernel.legal_entity', id: branch }), many],
      ),
    );

    const started = Date.now();
    await app.execute('kernel.member.role.assign', { userId: holder, roleKey: 'external_accountant', legalEntityId: defaultEntity }, { actor: asMfa(owner), orgId });
    expect(Date.now() - started).toBeLessThan(10_000);

    const counts = await admin(async (c) => ({
      left: (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_kernel.task WHERE assignee_position_id = $1', [own])).rows[0]?.n,
      moved: (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_kernel.task WHERE assignee_position_id = $1', [leadSeat])).rows[0]?.n,
      activity: (
        await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM crove_kernel.activity a JOIN crove_kernel.task t ON t.org_id = a.org_id AND t.id = a.record_id
           WHERE a.record_type = 'kernel.task' AND a.kind = 'task.rerouted' AND t.assignee_position_id = $1 AND a.legal_entity_id = $2`,
          [leadSeat, branch],
        )
      ).rows[0]?.n,
      events: (
        await c.query<{ id: string; count: number; ids: number }>(
          `SELECT id, (payload ->> 'count')::int AS count, jsonb_array_length(payload -> 'taskIds') AS ids FROM crove_kernel.outbox_event
           WHERE type = 'kernel.task.rerouted' AND payload ->> 'toPositionId' = $1`,
          [leadSeat],
        )
      ).rows,
    }));
    expect(counts).toMatchObject({ left: 0, moved: many, activity: many });
    expect(counts.events).toEqual([expect.objectContaining({ count: many, ids: 200 })]);
    await worker.execute('kernel.notification.dispatch', { eventId: counts.events[0]?.id }, { actor: SYSTEM, orgId });
    const notice = await admin(
      async (c) =>
        (await c.query<{ user_id: string; detail: Record<string, string> }>(`SELECT user_id, detail FROM crove_kernel.notification WHERE kind = 'kernel.task_rerouted' AND event_id = $1`, [counts.events[0]?.id])).rows,
    );
    expect(notice).toEqual([{ user_id: lead, detail: { count: String(many) } }]);
  });

  // task_reroute locks its target seats and then their holders' memberships, after the command locked its own seat or
  // members, so every command that may re-route takes one lock per org before any of its own (#1858): a second chart or
  // role change of the org waits for it there, holding nothing the first one could need.
  it('runs the chart and role changes of an org one at a time, each waiting before its own locks (#1858)', async () => {
    const holder = await member('queued', 'member', null);
    // Limited to the branch, so revoking the default entity's assignment below leaves one.
    const next = await member('queued-next', 'member', branch);
    const own = await seat('Kế toán kho', holder, null);
    const as = { actor: asMfa(owner), orgId };
    let assignmentId = '';
    // Every command that may re-route, in an order each can run in.
    const changes: Array<[string, () => Promise<unknown>]> = [
      ['kernel.position.update', () => app.execute('kernel.position.update', { id: own, title: 'Kế toán kho hàng' }, as)],
      ['kernel.position.assign', () => app.execute('kernel.position.assign', { id: own, holder: { type: 'user', userId: next } }, as)],
      [
        'kernel.member.role.assign',
        async () =>
          ({ assignmentId } = await app.execute<{ assignmentId: string }>(
            'kernel.member.role.assign',
            { userId: next, roleKey: 'external_accountant', legalEntityId: defaultEntity },
            as,
          )),
      ],
      ['kernel.member.role.revoke', () => app.execute('kernel.member.role.revoke', { assignmentId }, as)],
      ['kernel.member.change_role', () => app.execute('kernel.member.change_role', { userId: next, role: 'admin' }, as)],
      ['kernel.member.remove', () => app.execute('kernel.member.remove', { userId: next }, as)],
    ];
    for (const [name, run] of changes) {
      const chart = new pg.Client({ connectionString: adminUrl });
      await chart.connect();
      try {
        await chart.query('BEGIN');
        await chart.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))', [`crove_kernel.chart:${orgId}`]);
        const changing = run();
        await untilWaiting(name, { advisory: `crove_kernel.chart:${orgId}` });
        // It waits before taking the seat's or the members' locks.
        await admin((c) => c.query('SELECT 1 FROM crove_kernel.position WHERE org_id = $1 AND id = $2 FOR UPDATE NOWAIT', [orgId, own]));
        await admin((c) => c.query('SELECT 1 FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id IN ($2, $3) FOR UPDATE NOWAIT', [orgId, owner, next]));
        await chart.query('ROLLBACK');
        await changing;
      } finally {
        await chart.end();
      }
    }
  });

  // A deadlock on the definer's own locks is retried once, from its savepoint, which drops them (#1858). The cycle: the
  // re-route holds the target seat FOR SHARE and waits for its holder's membership, which another session holds and
  // which then asks for that seat. A third session holds the seat at first, so that the other session is already
  // waiting when the re-route starts its wait for the membership: PostgreSQL checks for a deadlock once per wait, after
  // deadlock_timeout (the server's default of 1 s for the re-route, 30 s for the other session), so the re-route is the
  // one that finds it.
  it('retries a deadlock on its own locks from its savepoint, which drops them (#1858)', async () => {
    const lead = await member('deadlock-lead', 'member', null);
    const holder = await member('deadlock-holder', 'member', null);
    const leadSeat = await seat('Trưởng ca', lead, null);
    const own = await seat('Nhân viên ca', holder, leadSeat);
    const ofBranch = await task(branch, own);
    // The holder's first entity assignment leaves the branch out; the re-route below is the one its command runs.
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        holder,
        defaultEntity,
        owner,
      ]),
    );
    const seatFirst = new pg.Client({ connectionString: adminUrl });
    const other = new pg.Client({ connectionString: adminUrl });
    const rerouter = new pg.Client({ connectionString: appUrl() });
    for (const c of [seatFirst, other, rerouter]) await c.connect();
    try {
      await other.query('BEGIN');
      await other.query(`SET LOCAL deadlock_timeout = '30s'`);
      await other.query('SELECT 1 FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2 FOR UPDATE', [orgId, lead]);
      await seatFirst.query('BEGIN');
      await seatFirst.query('SELECT 1 FROM crove_kernel.position WHERE org_id = $1 AND id = $2 FOR UPDATE', [orgId, leadSeat]);

      await rerouter.query('BEGIN');
      await enterUser(rerouter, owner, orgId);
      const pid = (await rerouter.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]?.pid as number;
      const otherPid = (await other.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]?.pid as number;
      const rerouted = rerouter.query<{ task_id: string; to_position_id: string | null }>(
        'SELECT task_id, to_position_id FROM crove_kernel.task_reroute($1::uuid[])',
        [[own]],
      );
      await untilWaiting('the re-route', { pid });
      // The other session queues for the seat behind it.
      const seatTaken = other.query('SELECT 1 FROM crove_kernel.position WHERE org_id = $1 AND id = $2 FOR UPDATE', [orgId, leadSeat]);
      await untilWaiting('the other session', { pid: otherPid });
      // The re-route takes the seat FOR SHARE and waits for the membership: the cycle is closed.
      await seatFirst.query('ROLLBACK');
      // The re-route found the deadlock and dropped its lock on the seat, with its transaction still open.
      await seatTaken;
      await other.query('ROLLBACK');
      // Its retry takes the locks again and moves the task.
      expect((await rerouted).rows).toEqual([{ task_id: ofBranch, to_position_id: leadSeat }]);
      await rerouter.query('COMMIT');
    } finally {
      for (const c of [seatFirst, other, rerouter]) {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    }
    expect(await taskRow(ofBranch)).toEqual({ assignee: leadSeat, status: 'todo' });
    expect((await trail(ofBranch)).activity).toEqual([{ kind: 'task.rerouted', entity: branch }]);
  });

  // A round's UPDATE skips a task whose target, in its snapshot, is a seat the round has not locked. When that target
  // then changes to the owners before the round ends, nothing unlocked is left, but the task is still stranded: the
  // next round moves it (#1902). Two sessions make that interleaving. A SHARE lock on the activity table holds the
  // round's UPDATE before it takes its snapshot (a statement takes its table locks first) while the chart changes, so
  // that one task's target is an unlocked seat. A lock on the other task's row then holds the UPDATE after its snapshot
  // while the chart changes back, so that the skipped task's target is the owners.
  it('moves a task whose unlocked target changed during the round, in another round (#1902)', async () => {
    const store = await admin(
      async (c) =>
        (
          await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Kho', 'branch', $2) RETURNING id`, [
            orgId,
            owner,
          ])
        ).rows[0]?.id as string,
    );
    const lead = await member('settle-lead', 'member', defaultEntity);
    const between = await member('settle-between', 'member', branch);
    const holder = await member('settle-holder', 'member', store);
    const leadSeat = await seat('Giám sát', lead, null);
    const betweenSeat = await seat('Phó giám sát', between, leadSeat);
    const own = await seat('Thủ kho', holder, leadSeat);
    // Its holder reads neither entity: the default entity's task goes to the lead, the branch's to the owners.
    const ofDefault = await task(defaultEntity, own);
    const ofBranch = await task(branch, own);
    const reportsTo = (to: string) => admin((c) => c.query('UPDATE crove_kernel.position SET reports_to = $1 WHERE org_id = $2 AND id = $3', [to, orgId, own]));
    const gate = new pg.Client({ connectionString: adminUrl });
    const rowLock = new pg.Client({ connectionString: adminUrl });
    const rerouter = new pg.Client({ connectionString: appUrl() });
    for (const c of [gate, rowLock, rerouter]) await c.connect();
    try {
      await gate.query('BEGIN');
      await gate.query('LOCK TABLE crove_kernel.activity IN SHARE MODE');
      await rowLock.query('BEGIN');
      await rowLock.query('SELECT 1 FROM crove_kernel.task WHERE org_id = $1 AND id = $2 FOR UPDATE', [orgId, ofDefault]);

      await rerouter.query('BEGIN');
      await enterUser(rerouter, owner, orgId);
      const pid = (await rerouter.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]?.pid as number;
      const rerouted = rerouter.query<{ task_id: string; to_position_id: string | null }>(
        'SELECT task_id, to_position_id FROM crove_kernel.task_reroute($1::uuid[])',
        [[own]],
      );
      rerouted.catch(() => {});
      // The first round locked the lead's seat; its UPDATE waits for the activity table.
      await untilWaiting('the round', { pid, table: 'crove_kernel.activity' });
      // The branch's task now goes to the seat between, which the round has not locked.
      await reportsTo(betweenSeat);
      await gate.query('ROLLBACK');
      // The UPDATE took its snapshot, skipped the branch's task and waits for the default entity's task.
      await untilWaiting("the round's UPDATE", { pid, row: true });
      // The branch's task goes to the owners again: no stranded task has an unlocked target.
      await reportsTo(leadSeat);
      await rowLock.query('ROLLBACK');
      const expected = [
        { task_id: ofDefault, to_position_id: leadSeat },
        { task_id: ofBranch, to_position_id: null },
      ].sort((a, b) => (a.task_id < b.task_id ? -1 : 1));
      expect((await rerouted).rows).toEqual(expected);
      await rerouter.query('COMMIT');
    } finally {
      for (const c of [gate, rowLock, rerouter]) {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    }
    expect(await taskRow(ofDefault)).toEqual({ assignee: leadSeat, status: 'todo' });
    expect(await taskRow(ofBranch)).toEqual({ assignee: null, status: 'todo' });
  });

  // A round can move a task to a seat that is itself among the given seats; a concurrent change that strands it there
  // before the round ends makes a later round move it again. It is answered once (#1907), from the seat it was first
  // stranded on to its last target, so the command's audit and events count it once; the activity rows keep both moves.
  // A lock on one task's row holds the first round's UPDATE after its snapshot while the middle seat's holder loses
  // the entity.
  it('answers a task moved by two rounds once, from its first seat to its last target (#1907)', async () => {
    const workshop = await admin(
      async (c) =>
        (
          await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Xưởng', 'branch', $2) RETURNING id`, [
            orgId,
            owner,
          ])
        ).rows[0]?.id as string,
    );
    const lead = await member('twice-lead', 'member', defaultEntity);
    const middle = await member('twice-middle', 'member', workshop);
    const holder = await member('twice-holder', 'member', workshop);
    // The middle seat's holder reads the default entity too, until the change below.
    const ofDefaultGrant = await admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4) RETURNING id`,
            [orgId, middle, defaultEntity, owner],
          )
        ).rows[0]?.id as string,
    );
    const leadSeat = await seat('Quản đốc', lead, null);
    const middleSeat = await seat('Tổ trưởng', middle, leadSeat);
    const own = await seat('Công nhân', holder, middleSeat);
    const first = await task(defaultEntity, own);
    const second = await task(defaultEntity, own);
    const rowLock = new pg.Client({ connectionString: adminUrl });
    const rerouter = new pg.Client({ connectionString: appUrl() });
    for (const c of [rowLock, rerouter]) await c.connect();
    try {
      await rowLock.query('BEGIN');
      await rowLock.query('SELECT 1 FROM crove_kernel.task WHERE org_id = $1 AND id = $2 FOR UPDATE', [orgId, second]);

      await rerouter.query('BEGIN');
      await enterUser(rerouter, owner, orgId);
      const pid = (await rerouter.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]?.pid as number;
      const rerouted = rerouter.query<{ task_id: string; from_position_id: string; to_position_id: string | null }>(
        'SELECT task_id, from_position_id, to_position_id FROM crove_kernel.task_reroute($1::uuid[])',
        [[own, middleSeat]],
      );
      rerouted.catch(() => {});
      // The first round moves both tasks to the middle seat; its UPDATE waits for the locked one.
      await untilWaiting("the first round's UPDATE", { pid, row: true });
      // The middle seat's holder no longer reads the default entity: once there, the tasks are stranded again.
      await admin((c) => c.query('DELETE FROM crove_kernel.role_assignment WHERE org_id = $1 AND id = $2', [orgId, ofDefaultGrant]));
      await rowLock.query('ROLLBACK');
      const expected = [first, second]
        .sort((a, b) => (a < b ? -1 : 1))
        .map((id) => ({ task_id: id, from_position_id: own, to_position_id: leadSeat }));
      expect((await rerouted).rows).toEqual(expected);
      await rerouter.query('COMMIT');
    } finally {
      for (const c of [rowLock, rerouter]) {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    }
    expect(await taskRow(first)).toEqual({ assignee: leadSeat, status: 'todo' });
    expect(await taskRow(second)).toEqual({ assignee: leadSeat, status: 'todo' });
    expect((await trail(first)).activity).toEqual([
      { kind: 'task.rerouted', entity: defaultEntity },
      { kind: 'task.rerouted', entity: defaultEntity },
    ]);
  });

  // The rounds end only when no task of the seats is stranded, so a task's target must never be a seat that would
  // strand it again: the escalation target and the stranded test read coverage the same way (the #1904 review). Every
  // seat and entity of the org, in the owner's context the commands run in: a chain of its own with a paused seat, a
  // vacant one and seats limited to one entity, and whatever the cases above built.
  it("never targets a seat that does not read the task's entity, nor the task's own seat (#1904 review)", async () => {
    const top = await seat('Giám đốc vùng', await member('pin-top', 'member', null), null);
    const paused = await seat('Phó giám đốc vùng', await member('pin-paused', 'member', null), top);
    await admin((c) => c.query(`UPDATE crove_kernel.position SET status = 'paused' WHERE org_id = $1 AND id = $2`, [orgId, paused]));
    const { positionId: vacant } = await app.execute<{ positionId: string }>(
      'kernel.position.create',
      { title: 'Vị trí trống', module: 'finance', roleKey: 'finance.accountant', reportsTo: paused },
      { actor: asMfa(owner), orgId },
    );
    const ofBranch = await seat('Kế toán chi nhánh vùng', await member('pin-branch', 'member', branch), vacant);
    const chain = [top, paused, vacant, ofBranch, await seat('Kế toán viên vùng', await member('pin-default', 'member', defaultEntity), ofBranch)];
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, owner, orgId);
      const { rows } = await c.query<{ seat: string; entity: string; target: string; reads: boolean }>(
        `SELECT x.seat, x.entity, x.target, crove_kernel.position_reads_legal_entity($1, x.target, x.entity) AS reads
         FROM (SELECT p.id AS seat, e.id AS entity, crove_kernel.task_escalation_target($1, p.id, e.id) AS target
               FROM crove_kernel.position p CROSS JOIN crove_kernel.legal_entity e
               WHERE p.org_id = $1 AND e.org_id = $1) x
         WHERE x.target IS NOT NULL`,
        [orgId],
      );
      // Every seat of the chain below the top has a target for every entity: the top's holder reads them all.
      const entities = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_kernel.legal_entity WHERE org_id = $1', [orgId])).rows[0]?.n ?? 0;
      expect(rows.filter((r) => chain.includes(r.seat)).length).toBe(entities * (chain.length - 1));
      expect(rows.filter((r) => r.target === r.seat || !r.reads)).toEqual([]);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  });

  it('answers which tasks only in an owner context', async () => {
    const someone = await member('someone', 'member', null);
    const url = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    const ask = async (login: string, password: string, enter: (c: pg.Client) => Promise<unknown>) => {
      const c = new pg.Client({ connectionString: url(login, password) });
      await c.connect();
      try {
        await c.query('BEGIN');
        await enter(c);
        await c.query('SELECT * FROM crove_kernel.task_reroute(ARRAY[]::uuid[])');
        return 'answered';
      } catch (e) {
        return (e as Error).message;
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    };
    await expect(ask('crove_app', 'test-app-pw', (c) => enterUser(c, owner, orgId))).resolves.toBe('answered');
    await expect(ask('crove_app', 'test-app-pw', (c) => enterUser(c, someone, orgId))).resolves.toBe(
      'TASK_REROUTE_OWNER_ONLY',
    );
    await expect(ask('crove_worker', 'test-worker-pw', (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]))).resolves.toMatch(
      /permission denied for function task_reroute/,
    );
  });
});
