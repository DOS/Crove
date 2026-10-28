// To-do reminders on PostgreSQL 17 (issue #1675, ADR-0037 §2, notes plan §3.8): the reminder claim is the worker
// login's alone, outside every context, and returns ids, owners and times, never a title, detail or step; it claims a
// reminder once and never one of a done, cancelled, handed-over or deleted to-do; the notification notes.todo.remind writes goes to
// the to-do's owner alone, only while the to-do still waits for that reminder, and holds none of its text. Part of the invariant suite; it imports package code under test,
// never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own
// database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { notesCommands, notesQueries } from '@crove/mod-notes';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const SECRET = 'Gọi khách xin sao kê tháng 10';
const CLAIM = 'SELECT * FROM crove_notes.todo_reminders_claim(100)';
const suite = ADMIN ? describe : describe.skip;

suite('to-do reminders on PostgreSQL (#1675, ADR-0037)', () => {
  const dbName = `crove_test_notes_reminders_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let orgId = '';
  const users = { owner: '', mine: '', other: '' };
  // Due to-dos of the member: open, done, cancelled, handed over and in the trash; and one not due yet.
  const todos = { open: randomUUID(), done: randomUUID(), cancelled: randomUUID(), handed: randomUUID(), trashed: randomUUID(), ahead: randomUUID() };
  let agent = { agentId: '', runId: '' };
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

  // Runs fn as a login role in a context, always rolled back.
  async function inContext<T>(url: string, enter: (c: pg.Client) => Promise<unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enter(c);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const outcome = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: { code?: string; message: string }) => ({ ok: false as const, code: error.code ?? '', message: error.message }));

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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    const runtimeFor = (url: string) => {
      const pool = createPool({ connectionString: url, max: 4 });
      pools.push(pool);
      const db = createDb(pool);
      return {
        db,
        runtime: new Runtime(db).register({
          commands: [...kernelCommands, ...financeCommands, ...notesCommands],
          queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries, ...notesQueries],
        }),
      };
    };
    const api = runtimeFor(appUrl);
    app = api.runtime;
    worker = runtimeFor(workerUrl).runtime;
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(api.db, { issuer: 'notes-reminders', subject: key, email: `${key}@notes-reminders.test`, name: null });
    }
    orgId = (await createOrg(api.runtime, asUser(users.owner), 'Nhắc việc')).orgId;
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`, [orgId, users.mine, users.other]);
      await c.query(
        `INSERT INTO crove_notes.todo (org_id, id, owner_user_id, title, details, status, done_at, sort_key, remind_at, deleted_at) VALUES
           ($1, $2, $7, $8, $8, 'open', NULL, 'a', now() - interval '1 minute', NULL),
           ($1, $3, $7, $8, NULL, 'done', now(), 'b', now() - interval '1 minute', NULL),
           ($1, $4, $7, $8, NULL, 'cancelled', NULL, 'c', now() - interval '1 minute', NULL),
           ($1, $5, $7, $8, NULL, 'open', NULL, 'd', now() - interval '1 minute', now()),
           ($1, $6, $7, $8, NULL, 'open', NULL, 'e', now() + interval '1 day', NULL)`,
        [orgId, todos.open, todos.done, todos.cancelled, todos.trashed, todos.ahead, users.mine, SECRET],
      );
    });
    const installed = await api.runtime.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: asMfa(users.owner), orgId },
    );
    const { taskId } = await api.runtime.execute<{ taskId: string }>('kernel.task.create', { title: 'Việc thử', assigneePositionId: installed.positionId }, { actor: asUser(users.owner), orgId });
    await admin((c) =>
      c.query(
        `INSERT INTO crove_notes.todo (org_id, id, owner_user_id, title, status, task_id, sort_key, remind_at) VALUES ($1, $2, $3, $4, 'handed_over', $5, 'f', now() - interval '1 minute')`,
        [orgId, todos.handed, users.mine, SECRET, taskId],
      ),
    );
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId: installed.agentId }, { actor: SYSTEM, orgId });
    agent = { agentId: installed.agentId, runId: started.runId as string };
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('refuses the claim to every login and context but the worker login outside every context', async () => {
    const callers: Array<[string, string, (c: pg.Client) => Promise<unknown>]> = [
      ['the app login, no context', appUrl, async () => {}],
      ['the to-do owner', appUrl, (c) => c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users.mine, orgId])],
      ['an owner of the org', appUrl, (c) => c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users.owner, orgId])],
      ['the system context', workerUrl, (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId])],
      ['an agent context', workerUrl, (c) => c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agent.agentId, agent.runId])],
    ];
    for (const [name, url, enter] of callers) {
      expect(await outcome(inContext(url, enter, (c) => c.query(CLAIM))), name).toMatchObject({ ok: false, code: '42501' });
    }
    // The check notes.todo.remind makes is the worker's, in the org's system context only, and answers an owner or null.
    const check = 'SELECT crove_notes.todo_reminder_owner($1::uuid, now()) AS owner';
    const noContext: [string, string, (c: pg.Client) => Promise<unknown>] = ['the worker login, no context', workerUrl, async () => {}];
    for (const [name, url, enter] of [...callers.filter(([n]) => n !== 'the system context'), noContext]) {
      expect(await outcome(inContext(url, enter, (c) => c.query(check, [todos.open]))), name).toMatchObject({ ok: false, code: '42501' });
    }
    const answer = await inContext(workerUrl, (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]), (c) => c.query(check, [todos.ahead]));
    expect(answer.fields.map((f) => f.name)).toEqual(['owner']);
    // Never claimed, so not a reminder to send.
    expect(answer.rows).toEqual([{ owner: null }]);
  });

  it('claims a due reminder once, with ids and times only, and never one of a done, cancelled or deleted to-do', async () => {
    const claim = async () => {
      const c = new pg.Client({ connectionString: workerUrl });
      await c.connect();
      try {
        return await c.query(CLAIM);
      } finally {
        await c.end();
      }
    };
    const first = await claim();
    expect(first.fields.map((f) => f.name)).toEqual(['org_id', 'id', 'owner_user_id', 'remind_at']);
    const ours = first.rows.filter((r: { org_id: string }) => r.org_id === orgId);
    expect(ours.map((r: { id: string; owner_user_id: string }) => [r.id, r.owner_user_id])).toEqual([[todos.open, users.mine]]);
    expect(JSON.stringify(first.rows)).not.toContain(SECRET);
    const second = await claim();
    expect(second.rows.filter((r: { org_id: string }) => r.org_id === orgId)).toEqual([]);

    // The reminder: one notification for the owner, about the to-do's id, with none of its text.
    const remindAt = (ours[0] as { remind_at: Date }).remind_at.toISOString();
    const input = { todoId: todos.open, remindAt };
    expect(await worker.execute('notes.todo.remind', input, { actor: { type: 'system', component: 'notes' }, orgId })).toEqual({ sent: 1 });
    // Replayed, it writes nothing; nor for another time, a to-do it did not claim or one of another org.
    const remind = (i: { todoId: string; remindAt: string }, org = orgId) => worker.execute('notes.todo.remind', i, { actor: { type: 'system', component: 'notes' }, orgId: org });
    expect(await remind(input)).toEqual({ sent: 0 });
    expect(await remind({ todoId: todos.open, remindAt: new Date(Date.parse(remindAt) + 60_000).toISOString() })).toEqual({ sent: 0 });
    for (const todoId of [todos.done, todos.cancelled, todos.handed, todos.trashed, todos.ahead, randomUUID()]) expect(await remind({ todoId, remindAt }), todoId).toEqual({ sent: 0 });
    const rows = await admin(async (c) => (await c.query(`SELECT * FROM crove_kernel.notification WHERE org_id = $1 AND kind = 'notes.todo_due'`, [orgId])).rows);
    expect(rows.map((r: { user_id: string; subject_type: string; subject_id: string; detail: unknown }) => [r.user_id, r.subject_type, r.subject_id, r.detail])).toEqual([
      [users.mine, 'notes.todo', todos.open, {}],
    ]);
    const written = await admin(async (c) => [
      ...rows,
      ...(await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'notes.todo.remind'`, [orgId])).rows,
      ...(await c.query(`SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1`, [orgId])).rows,
    ]);
    expect(JSON.stringify(written)).not.toContain(SECRET);
    // No member but the owner is notified, and nobody but a system command writes one.
    await expect(
      inContext(appUrl, (c) => c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users.other, orgId]), (c) => c.query(`SELECT * FROM crove_kernel.notification WHERE kind = 'notes.todo_due'`)),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(app.execute('notes.todo.remind', input, { actor: asUser(users.other), orgId })).rejects.toMatchObject({ status: 403 });
  });

  // Due reminders of the other member, written for one test and claimed by it.
  const dueTodos = async (count: number): Promise<string[]> => {
    const ids = Array.from({ length: count }, () => randomUUID());
    await admin(async (c) => {
      for (const [i, id] of ids.entries()) {
        await c.query(`INSERT INTO crove_notes.todo (org_id, id, owner_user_id, title, status, sort_key, remind_at) VALUES ($1, $2, $3, $4, 'open', $5, now() - interval '1 minute')`, [
          orgId,
          id,
          users.other,
          SECRET,
          `z${i}`,
        ]);
      }
    });
    return ids;
  };

  it('never returns a reminder to two claims running at once, and one claim does not wait for the other (#1752)', async () => {
    const ids = await dueTodos(3);
    const first = new pg.Client({ connectionString: workerUrl });
    const second = new pg.Client({ connectionString: workerUrl });
    await first.connect();
    await second.connect();
    try {
      // The first claim stays open, holding its rows; the second runs meanwhile and must neither wait for it nor return
      // the same reminders.
      await first.query('BEGIN');
      const held = (await first.query<{ id: string }>(CLAIM)).rows.map((r) => r.id);
      expect(held.sort()).toEqual([...ids].sort());
      await second.query('BEGIN');
      await second.query(`SET LOCAL lock_timeout = '2s'`);
      const meanwhile = await outcome(second.query<{ id: string }>(CLAIM));
      expect(meanwhile).toMatchObject({ ok: true });
      expect(meanwhile.ok ? meanwhile.value.rows : null).toEqual([]);
      await second.query('COMMIT');
      // Once the first commits, a new claim finds nothing either: each reminder went out once.
      await first.query('COMMIT');
      expect((await second.query(CLAIM)).rows).toEqual([]);
    } finally {
      await first.query('ROLLBACK').catch(() => {});
      await second.query('ROLLBACK').catch(() => {});
      await first.end();
      await second.end();
    }
    const marked = await admin(async (c) => (await c.query(`SELECT count(*)::int AS n FROM crove_notes.todo WHERE org_id = $1 AND id = ANY($2::uuid[]) AND reminded_at IS NOT NULL`, [orgId, ids])).rows[0]);
    expect(marked).toEqual({ n: 3 });
  });

  it('sends no reminder to an owner who left the org after the claim (#1752)', async () => {
    const [todoId] = await dueTodos(1);
    const claimed = await inContext(workerUrl, async () => {}, async (c) => {
      const rows = (await c.query<{ id: string; remind_at: Date }>(CLAIM)).rows;
      await c.query('COMMIT');
      return rows;
    });
    expect(claimed.map((r) => r.id)).toEqual([todoId]);
    const remindAt = (claimed[0] as { remind_at: Date }).remind_at.toISOString();
    const owner = () =>
      inContext(workerUrl, (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]), (c) =>
        c.query<{ owner: string | null }>('SELECT crove_notes.todo_reminder_owner($1::uuid, $2::timestamptz) AS owner', [todoId, remindAt]),
      ).then((r) => r.rows[0]?.owner);
    expect(await owner()).toBe(users.other);
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, users.other]));
    try {
      // The definer no longer answers the former member, and the command writes no notification for them.
      expect(await owner()).toBeNull();
      expect(await worker.execute('notes.todo.remind', { todoId, remindAt }, { actor: { type: 'system', component: 'notes' }, orgId })).toEqual({ sent: 0 });
      const rows = await admin(async (c) => (await c.query(`SELECT 1 FROM crove_kernel.notification WHERE org_id = $1 AND kind = 'notes.todo_due' AND subject_id = $2`, [orgId, todoId])).rowCount);
      expect(rows).toBe(0);
    } finally {
      await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, users.other]));
    }
  });
});
