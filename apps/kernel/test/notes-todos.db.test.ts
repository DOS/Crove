// A member's own to-dos through the runtime on PostgreSQL 17 (issue #1673, plan docs/plan/notes.md step N4): a member
// adds, edits, completes, reorders and deletes their to-dos; another member, an owner and an admin read none of them
// and change none; a to-do due today in its own time zone lists under Hôm nay; checklist steps save; the audit rows
// keep markers, not text; the system empties the trash and a former member's to-dos;
// owners and admins get only how many each member has. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run makes its
// own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { zonedDate, type Todo, type TodoCount, type TodoSummary, type TodoWritten } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { notesCommands, notesQueries } from '@crove/mod-notes';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'notes' };
const TITLE = 'Gọi khách xin sao kê tháng 10';
const DETAILS = 'Hỏi kế toán trưởng bên khách';
const STEP = 'Gửi email nhắc';
// The zones furthest apart: at any instant Kiritimati's date is a day or two after Pago Pago's.
const EAST = 'Pacific/Kiritimati';
const WEST = 'Pacific/Pago_Pago';
const suite = ADMIN ? describe : describe.skip;

suite('personal to-dos on PostgreSQL (#1673)', () => {
  const dbName = `crove_test_notes_todos_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // A fresh org: its owner, an admin, the member whose to-dos these are, another member and a viewer.
  async function org() {
    const tag = randomUUID().slice(0, 8);
    const user = (name: string) => upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'todos', subject: `${name}-${tag}`, email: `${name}-${tag}@todos.test`, name: null });
    const owner = await user('owner');
    const adminUser = await user('admin');
    const mine = await user('mine');
    const other = await user('other');
    const viewer = await user('viewer');
    const { orgId } = await createOrg(app, asUser(owner), `Việc ${tag}`);
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')`, [
        orgId,
        adminUser,
        mine,
        other,
        viewer,
      ]),
    );
    const exec = <O>(userId: string, name: string, input: unknown = {}) => app.execute<O>(name, input, { actor: asUser(userId), orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => app.query<O>(name, input, { actor: asUser(userId), orgId });
    const list = (userId: string, view = 'open') => query<TodoSummary[]>(userId, 'notes.todo.list', { view });
    return { orgId, owner, admin: adminUser, mine, other, viewer, exec, query, list };
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
    const runtimeFor = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      const pool = createPool({ connectionString: url.toString(), max: 4 });
      pools.push(pool);
      return new Runtime(createDb(pool)).register({ commands: [...kernelCommands, ...notesCommands], queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries] });
    };
    app = runtimeFor('crove_app', 'test-app-pw');
    worker = runtimeFor('crove_worker', 'test-worker-pw');
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("keeps a member's to-do from every other member, the org's owner and admins included", async () => {
    const o = await org();
    const { todoId } = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: TITLE, details: DETAILS, checklist: [{ text: STEP, done: false }] });
    expect((await o.list(o.mine)).map((t) => t.id)).toEqual([todoId]);
    for (const reader of [o.other, o.owner, o.admin, o.viewer]) {
      for (const view of ['open', 'done', 'trash']) expect(await o.list(reader, view), `${reader} ${view}`).toEqual([]);
      await expect(o.query(reader, 'notes.todo.get', { todoId })).rejects.toMatchObject({ code: 'TODO_NOT_FOUND', status: 404 });
    }
    for (const writer of [o.other, o.owner, o.admin]) {
      await expect(o.exec(writer, 'notes.todo.complete', { todoId })).rejects.toMatchObject({ code: 'TODO_NOT_FOUND' });
      await expect(o.exec(writer, 'notes.todo.delete', { todoId })).rejects.toMatchObject({ code: 'TODO_NOT_FOUND' });
      await expect(
        o.exec(writer, 'notes.todo.update', { todoId, revision: 1, title: 'đổi', details: '', checklist: [], dueOn: null, dueTime: null, timeZone: 'UTC' }),
      ).rejects.toMatchObject({ code: 'TODO_NOT_FOUND' });
    }
    // Another member's own to-do is not an anchor for a move.
    const theirs = await o.exec<TodoWritten>(o.other, 'notes.todo.create', { title: 'Của người khác' });
    await expect(o.exec(o.mine, 'notes.todo.reorder', { todoId, place: 'before', anchorId: theirs.todoId })).rejects.toMatchObject({ code: 'TODO_NOT_FOUND' });
    // Viewers keep no to-do.
    await expect(o.exec(o.viewer, 'notes.todo.create', { title: 'Việc' })).rejects.toMatchObject({ status: 403 });
    const got = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId });
    expect(got).toMatchObject({ title: TITLE, details: DETAILS, checklist: [{ text: STEP, done: false }], status: 'open', group: 'none', revision: 1 });
  });

  it('lists a to-do due today in its own time zone under Hôm nay', async () => {
    const o = await org();
    const now = Date.now();
    const eastToday = zonedDate(EAST, now);
    const westToday = zonedDate(WEST, now);
    expect(eastToday > westToday).toBe(true);
    const east = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: 'Hôm nay ở phía đông', dueOn: eastToday, timeZone: EAST });
    // The same day is tomorrow or after in Pago Pago, and its today is yesterday or before in Kiritimati.
    const west = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: 'Ngày mai ở phía tây', dueOn: eastToday, timeZone: WEST });
    const late = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: 'Hôm qua ở phía đông', dueOn: westToday, timeZone: EAST });
    const timed = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: 'Có giờ', dueOn: westToday, dueTime: '23:59', timeZone: WEST });
    const byId = new Map((await o.list(o.mine)).map((t) => [t.id, t]));
    expect(byId.get(east.todoId)).toMatchObject({ group: 'today', dueOn: eastToday, timeZone: EAST, dueTime: null });
    expect(byId.get(west.todoId)).toMatchObject({ group: 'next7', overdue: false });
    expect(byId.get(late.todoId)).toMatchObject({ group: 'overdue', overdue: true });
    // A due time is an instant on that day in the to-do's zone, and reads back as that wall-clock time.
    const t = byId.get(timed.todoId);
    expect(t).toMatchObject({ group: 'today', dueTime: '23:59' });
    expect(zonedDate(WEST, Date.parse(t?.dueAt ?? ''))).toBe(westToday);
    // A time with no day is refused.
    await expect(o.exec(o.mine, 'notes.todo.create', { title: 'Giờ mà không ngày', dueTime: '09:00' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('saves checklist steps and edits against the revision, with markers in the audit rows', async () => {
    const o = await org();
    const { todoId } = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: TITLE, checklist: [{ text: STEP, done: false }] });
    const edit = (revision: number, checklist: Array<{ text: string; done: boolean }>) =>
      o.exec<TodoWritten>(o.mine, 'notes.todo.update', { todoId, revision, title: TITLE, details: DETAILS, checklist, dueOn: '2026-11-05', dueTime: '09:30', timeZone: 'Asia/Ho_Chi_Minh' });
    const saved = await edit(1, [
      { text: STEP, done: true },
      { text: 'Lưu sao kê vào hồ sơ', done: false },
    ]);
    expect(saved).toEqual({ todoId, revision: 2 });
    const got = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId });
    expect(got).toMatchObject({
      details: DETAILS,
      checklist: [
        { text: STEP, done: true },
        { text: 'Lưu sao kê vào hồ sơ', done: false },
      ],
      steps: { done: 1, total: 2 },
      dueOn: '2026-11-05',
      dueTime: '09:30',
      dueAt: '2026-11-05T02:30:00.000Z',
    });
    // A stale revision is refused, and names the current one.
    await expect(edit(1, [])).rejects.toMatchObject({ code: 'TODO_REVISION_CONFLICT', status: 409 });
    // The database keeps the shape of a checklist whoever writes it.
    await expect(admin((c) => c.query(`UPDATE crove_notes.todo SET checklist = '[{"text": "", "done": false}]'::jsonb WHERE id = $1`, [todoId]))).rejects.toMatchObject({ code: '23514' });
    await expect(admin((c) => c.query(`UPDATE crove_notes.todo SET checklist = '[{"text": "x", "done": "yes"}]'::jsonb WHERE id = $1`, [todoId]))).rejects.toMatchObject({ code: '23514' });
    const audit = await admin((c) =>
      c.query<{ command: string; detail: unknown }>(`SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'notes.todo.%' ORDER BY occurred_at, id`, [o.orgId]),
    );
    const text = JSON.stringify(audit.rows);
    expect(audit.rows.map((r) => r.command)).toEqual(['notes.todo.create', 'notes.todo.update']);
    for (const secret of [TITLE, DETAILS, STEP, 'Lưu sao kê']) expect(text).not.toContain(secret);
    expect(text).toContain('"redacted":"pii"');
    // Results and outbox events carry no text either.
    const events = await admin((c) => c.query<{ payload: unknown }>(`SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1`, [o.orgId]));
    expect(JSON.stringify(events.rows)).not.toContain(TITLE);
  });

  it('completes, reopens, reorders and trashes a to-do', async () => {
    const o = await org();
    const add = async (title: string) => (await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title })).todoId;
    // A new to-do goes first.
    const c = await add('C');
    const b = await add('B');
    const a = await add('A');
    const order = async () => (await o.list(o.mine)).map((t) => t.title).join('');
    expect(await order()).toBe('ABC');
    await o.exec(o.mine, 'notes.todo.reorder', { todoId: a, place: 'after', anchorId: c });
    expect(await order()).toBe('BCA');
    await o.exec(o.mine, 'notes.todo.reorder', { todoId: c, place: 'before', anchorId: b });
    expect(await order()).toBe('CBA');
    // Many moves to the same place stay in order: the keys get fresh ones when they grow long.
    for (let i = 0; i < 60; i++) await o.exec(o.mine, 'notes.todo.reorder', { todoId: i % 2 === 0 ? a : b, place: 'after', anchorId: c });
    expect(await order()).toBe('CBA');
    const keys = await admin((cl) => cl.query<{ sort_key: string }>(`SELECT sort_key FROM crove_notes.todo WHERE org_id = $1`, [o.orgId]));
    for (const r of keys.rows) expect(r.sort_key.length).toBeLessThanOrEqual(49);

    await o.exec(o.mine, 'notes.todo.complete', { todoId: b });
    expect(await order()).toBe('CA');
    expect((await o.list(o.mine, 'done')).map((t) => [t.title, t.status, t.doneAt !== null])).toEqual([['B', 'done', true]]);
    await o.exec(o.mine, 'notes.todo.reopen', { todoId: b });
    expect(await order()).toBe('CBA');
    await o.exec(o.mine, 'notes.todo.delete', { todoId: a });
    expect(await order()).toBe('CB');
    expect((await o.list(o.mine, 'trash')).map((t) => t.title)).toEqual(['A']);
    await expect(o.exec(o.mine, 'notes.todo.complete', { todoId: a })).rejects.toMatchObject({ code: 'TODO_IN_TRASH' });
    await o.exec(o.mine, 'notes.todo.restore', { todoId: a });
    expect(await order()).toBe('CBA');
  });

  it("empties the trash and a former member's to-dos, and counts to-dos for owners and the export only", async () => {
    const o = await org();
    const kept = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: 'Giữ lại' });
    const old = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: 'Đã bỏ lâu' });
    await o.exec(o.mine, 'notes.todo.delete', { todoId: old.todoId });
    await o.exec(o.other, 'notes.todo.create', { title: 'Của người khác' });
    expect((await o.query<TodoCount[]>(o.owner, 'notes.todo.counts')).sort((x, y) => x.userId.localeCompare(y.userId))).toEqual(
      [
        { userId: o.mine, todos: 1 },
        { userId: o.other, todos: 1 },
      ].sort((x, y) => x.userId.localeCompare(y.userId)),
    );
    await expect(o.query(o.mine, 'notes.todo.counts')).rejects.toMatchObject({ status: 403 });
    // In the trash for longer than the limit: the system's sweep removes it, and only it.
    await admin((c) => c.query(`UPDATE crove_notes.todo SET deleted_at = now() - interval '31 days' WHERE id = $1`, [old.todoId]));
    expect(await worker.execute('notes.trash.empty', {}, { actor: SYSTEM, orgId: o.orgId })).toEqual({ removed: 1 });
    expect((await o.list(o.mine)).map((t) => t.id)).toEqual([kept.todoId]);
    // A former member's to-dos go with their private notes; the other member's stay.
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.mine]));
    const event = await admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.member.removed' AND payload ->> 'userId' = $2 ORDER BY id DESC LIMIT 1`,
            [o.orgId, o.mine],
          )
        ).rows[0]?.id ?? randomUUID(),
    );
    expect(await worker.execute('notes.member_items.purge', { userId: o.mine, eventId: event }, { actor: SYSTEM, orgId: o.orgId })).toEqual({ removed: 1 });
    const left = await admin((c) => c.query<{ owner_user_id: string }>(`SELECT owner_user_id FROM crove_notes.todo WHERE org_id = $1`, [o.orgId]));
    expect(left.rows).toEqual([{ owner_user_id: o.other }]);
  });
});
