// Personal to-dos on PostgreSQL 17 (issue #1673, ADR-0037 §2, notes plan exit criterion 1): a to-do is read and changed
// only in a context whose user is its owner. Another member, an owner, an admin, a viewer, a member limited to some
// legal entities, an agent context and the system context read none of it, find none of its words, change none of it,
// write none for its owner and delete none, through raw SQL in their own context; a forged context reaches nothing.
// The definers the worker and owners use return counts, never text, and refuse every other caller. Part of the
// invariant suite; it imports package code under test, never helpers from outside test/invariant/. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const SECRET = 'Gọi khách xin sao kê tháng 10';
const suite = ADMIN ? describe : describe.skip;

suite('personal to-dos on PostgreSQL (#1673, ADR-0037)', () => {
  const dbName = `crove_test_notes_todo_private_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let branch = '';
  const users = { owner: '', admin: '', mine: '', member: '', viewer: '', limited: '' };
  // The member's open to-do with a checklist, and one in the trash.
  const todos = { open: randomUUID(), trashed: randomUUID() };
  // A private note of the to-do's owner and one of another member, for to-dos made from a note.
  const notes = { own: randomUUID(), theirs: randomUUID() };
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

  interface Actor {
    name: string;
    url: () => string;
    enter: (c: pg.Client) => Promise<unknown>;
  }
  const member = (name: string, userId: () => string): Actor => ({
    name,
    url: () => appUrl,
    enter: (c) => c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId(), orgId]),
  });
  const system: Actor = { name: 'the system context', url: () => workerUrl, enter: (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]) };
  const agentActor: Actor = {
    name: 'an agent context',
    url: () => workerUrl,
    enter: (c) => c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agent.agentId, agent.runId]),
  };
  const owner = member('the to-do owner', () => users.mine);
  // Everyone but the to-do's owner.
  const others: Actor[] = [
    member('another member', () => users.member),
    member('an owner of the org', () => users.owner),
    member('an admin', () => users.admin),
    member('a viewer', () => users.viewer),
    member('a member limited to a branch', () => users.limited),
    agentActor,
    system,
  ];
  const run = <T>(actor: Actor, fn: (c: pg.Client) => Promise<T>) => inContext(actor.url(), actor.enter, fn);
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
      return { db, runtime: new Runtime(db).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries] }) };
    };
    const api = runtimeFor(appUrl);
    const worker = runtimeFor(workerUrl).runtime;
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(api.db, { issuer: 'notes-todo-private', subject: key, email: `${key}@notes-todo-private.test`, name: null });
    }
    orgId = (await createOrg(api.runtime, asUser(users.owner), 'Việc riêng')).orgId;
    await admin(async (c) => {
      branch = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, users.owner]))
        .rows[0]?.id as string;
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer'), ($1, $6, 'member')`,
        [orgId, users.admin, users.mine, users.member, users.viewer, users.limited],
      );
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        users.limited,
        branch,
        users.owner,
      ]);
      await c.query(
        `INSERT INTO crove_notes.todo (org_id, id, owner_user_id, title, details, checklist, due_on, sort_key, deleted_at) VALUES
           ($1, $2, $4, $5, $5, '[{"text": "Gửi email cho khách", "done": false}]'::jsonb, current_date, 'V', NULL),
           ($1, $3, $4, 'Việc đã bỏ', NULL, '[]'::jsonb, NULL, 'k', now() - interval '40 days')`,
        [orgId, todos.open, todos.trashed, users.mine, SECRET],
      );
      await c.query(`INSERT INTO crove_notes.note (org_id, id, author_user_id, title) VALUES ($1, $2, $3, 'Của tôi'), ($1, $4, $5, 'Của người khác')`, [
        orgId,
        notes.own,
        users.mine,
        notes.theirs,
        users.member,
      ]);
    });
    const installed = await api.runtime.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: asMfa(users.owner), orgId },
    );
    await api.runtime.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: installed.positionId }, { actor: asUser(users.owner), orgId });
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

  it('shows the owner their to-dos, words and steps', async () => {
    const seen = await run(owner, async (c) => ({
      ids: (await c.query<{ id: string }>('SELECT id FROM crove_notes.todo ORDER BY id')).rows.map((r) => r.id),
      searched: (await c.query(`SELECT id FROM crove_notes.todo WHERE search @@ crove_kernel.search_query('sao ke')`)).rowCount,
      steps: (await c.query<{ steps: unknown }>('SELECT checklist AS steps FROM crove_notes.todo WHERE id = $1', [todos.open])).rows[0]?.steps,
    }));
    expect(seen.ids).toEqual([todos.open, todos.trashed].sort());
    expect(seen.searched).toBe(1);
    expect(seen.steps).toEqual([{ text: 'Gửi email cho khách', done: false }]);
  });

  it("lets no one but the owner read a member's to-do, by id, by its words or by a count", async () => {
    for (const actor of others) {
      const seen = await run(actor, async (c) => ({
        all: (await c.query('SELECT id FROM crove_notes.todo')).rowCount,
        byId: (await c.query('SELECT title, details, checklist, search FROM crove_notes.todo WHERE id = $1', [todos.open])).rowCount,
        searched: (await c.query(`SELECT id FROM crove_notes.todo WHERE search @@ crove_kernel.search_query('sao ke')`)).rowCount,
        counted: (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_notes.todo')).rows[0]?.n,
      }));
      expect(seen, actor.name).toEqual({ all: 0, byId: 0, searched: 0, counted: 0 });
    }
  });

  it("lets no one but the owner change, delete or write a to-do for the owner", async () => {
    for (const actor of others) {
      const where = actor.name;
      const updated = await outcome(run(actor, (c) => c.query(`UPDATE crove_notes.todo SET title = 'đổi', status = 'cancelled' WHERE id = $1`, [todos.open])));
      if (updated.ok) expect(updated.value.rowCount, `${where} updating the to-do`).toBe(0);
      else expect(updated, `${where} updating the to-do`).toMatchObject({ code: '42501' });
      // A sweep with no WHERE clause reads no column, so no SELECT policy hides the row from it: the update policy must.
      const swept = await outcome(run(actor, (c) => c.query(`UPDATE crove_notes.todo SET sort_key = sort_key`)));
      if (swept.ok) expect(swept.value.rowCount, `${where} updating every to-do`).toBe(0);
      else expect(swept, `${where} updating every to-do`).toMatchObject({ code: '42501' });
      expect(await outcome(run(actor, (c) => c.query('DELETE FROM crove_notes.todo WHERE id = $1', [todos.open]))), `${where} deleting the to-do`).toMatchObject({ ok: false, code: '42501' });
      const forged = await outcome(
        run(actor, (c) => c.query(`INSERT INTO crove_notes.todo (org_id, owner_user_id, title, sort_key) VALUES ($1, $2, 'giả', 'a')`, [orgId, users.mine])),
      );
      expect(forged, `${where} writing a to-do for its owner`).toMatchObject({ ok: false, code: '42501' });
    }
    const after = await admin((c) => c.query<{ title: string; status: string }>('SELECT title, status FROM crove_notes.todo WHERE id = $1', [todos.open]));
    expect(after.rows).toEqual([{ title: SECRET, status: 'open' }]);
    // Nobody hands a to-do to someone else, its owner included.
    expect(await outcome(run(owner, (c) => c.query('UPDATE crove_notes.todo SET owner_user_id = $2 WHERE id = $1', [todos.open, users.member])))).toMatchObject({
      ok: false,
      code: '42501',
    });
  });

  it("lets no to-do name another member's private note, so the foreign key tells nothing of it", async () => {
    const fromNote = (noteId: string) =>
      outcome(run(owner, (c) => c.query(`INSERT INTO crove_notes.todo (org_id, owner_user_id, title, sort_key, source_note_id) VALUES ($1, $2, 'Từ ghi chú', 'a', $3)`, [orgId, users.mine, noteId])));
    expect(await fromNote(notes.theirs)).toMatchObject({ ok: false, code: '42501' });
    // A note that does not exist is refused the same way, before the foreign key is checked.
    expect(await fromNote(randomUUID())).toMatchObject({ ok: false, code: '42501' });
    expect(await fromNote(notes.own)).toMatchObject({ ok: true });
  });

  it('reaches nothing through a forged context', async () => {
    const forged = await outcome(
      run(member('another member, forging the owner', () => users.member), async (c) => {
        await c.query(`SELECT set_config('crove.ctx', (current_setting('crove.ctx')::jsonb || $1::jsonb)::text, true)`, [JSON.stringify({ user: users.mine })]);
        return (await c.query('SELECT id FROM crove_notes.todo WHERE id = $1', [todos.open])).rowCount;
      }),
    );
    // Refused outright, or the context no longer names a user: either way the to-do stays out of reach.
    expect(forged.ok ? forged.value : 0).toBe(0);
  });

  it('counts to-dos for owners and admins and the system context only, with no text', async () => {
    const counts = (actor: Actor) => outcome(run(actor, (c) => c.query('SELECT * FROM crove_notes.todo_counts()')));
    for (const actor of [member('an owner', () => users.owner), member('an admin', () => users.admin), system]) {
      const result = await counts(actor);
      expect(result, actor.name).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(result.value.fields.map((f) => f.name), actor.name).toEqual(['org_id', 'owner_user_id', 'todos']);
      // The one outside the trash.
      expect(result.value.rows, actor.name).toEqual([{ org_id: orgId, owner_user_id: users.mine, todos: '1' }]);
    }
    for (const actor of [owner, member('another member', () => users.member), member('a viewer', () => users.viewer), agentActor]) {
      expect(await counts(actor), actor.name).toMatchObject({ ok: false, code: '42501' });
    }
  });

  it('keeps the trash and member purge definers to the worker login in the system context', async () => {
    const calls: Array<[string, unknown[]]> = [
      ['SELECT * FROM crove_notes.trash_due(now(), 10)', []],
      ['SELECT crove_notes.trash_empty(now())', []],
      ['SELECT crove_notes.member_items_purge($1::uuid)', [users.mine]],
    ];
    for (const [text, values] of calls) {
      for (const actor of [owner, member('an owner', () => users.owner), agentActor]) {
        expect(await outcome(run(actor, (c) => c.query(text, values))), `${actor.name}: ${text}`).toMatchObject({ ok: false, code: '42501' });
      }
    }
    // The sweep names the org of the old trashed to-do, and nothing else of it.
    const due = await inContext(workerUrl, async () => {}, (c) => c.query(`SELECT * FROM crove_notes.trash_due(now() - interval '30 days', 10)`));
    expect(due.fields.map((f) => f.name)).toEqual(['org_id']);
    expect(due.rows).toEqual([{ org_id: orgId }]);
  });

  // Last: it removes the owner from the org.
  it("removes a former member's to-dos and private notes only once they are no longer a member", async () => {
    const purge = () => run(system, async (c) => (await c.query<{ n: string }>('SELECT crove_notes.member_items_purge($1::uuid) AS n', [users.mine])).rows[0]?.n);
    expect(await purge()).toBe('0');
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, users.mine]));
    // Their two to-dos and their private note.
    expect(await purge()).toBe('3');
  });
});
