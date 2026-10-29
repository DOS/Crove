// Open tasks a chart or role change would strand go up the chart (#1799) on PostgreSQL, as the real login roles. A task
// of a legal entity is listed by its position's holder only while that holder reads the entity (#1762, #1788). When a
// change takes that away (another holder, a narrower seat scope, a person's first entity assignment, a demotion, an
// owner's own), the
// command moves each such open task to the entity-aware escalation target of #1788, else to the owners, with an
// activity row that takes the task's entity, an event the notification dispatch turns into a notice for whoever has it
// now, and the moves in the command's audit row. Org-level tasks and tasks the holder still reads stay. The database
// answers which tasks (crove_kernel.task_stranded), for an owner's context only.
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
      events: (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.outbox_event WHERE type = 'kernel.task.rerouted' AND payload ->> 'taskId' = $1`, [taskId])).rows,
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
          await c.query<{ detail: { rerouted_tasks?: unknown } }>(
            `SELECT detail FROM crove_kernel.audit_event WHERE command = 'kernel.position.assign' AND target_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
            [clerkSeat],
          )
        ).rows[0]?.detail,
    );
    expect(audit?.rerouted_tasks).toEqual([{ task: ofDefault, from: clerkSeat, to: leadSeat }]);
    // The lead lists it now.
    const listed = await app.query<{ tasks: Array<{ id: string }> }>('kernel.task.list', {}, { actor: asUser(lead), orgId });
    expect(listed.tasks.map((t) => t.id)).toContain(ofDefault);
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
        await c.query('SELECT * FROM crove_kernel.task_stranded(ARRAY[]::uuid[])');
        return 'answered';
      } catch (e) {
        return (e as Error).message;
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    };
    await expect(ask('crove_app', 'test-app-pw', (c) => c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [owner, orgId]))).resolves.toBe('answered');
    await expect(ask('crove_app', 'test-app-pw', (c) => c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [someone, orgId]))).resolves.toBe(
      'TASK_STRANDED_OWNER_ONLY',
    );
    await expect(ask('crove_worker', 'test-worker-pw', (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]))).resolves.toMatch(
      /permission denied for function task_stranded/,
    );
  });
});
